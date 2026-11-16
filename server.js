/**
 * FITGEAR PAKISTAN - LOCAL DEVELOPMENT & STANDALONE HTTP SERVER
 * Inspired by Daraz Pakistan
 * Powered by Node.js native HTTP, SQLite (node:sqlite DatabaseSync), and Web Standards.
 * In production on Netlify, requests are routed to netlify/functions/api.js.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { handleApiRequest, getCorsHeaders } = require('./backend/router');
const { getDatabase, getDbPath } = require('./backend/db');

// Load environment variables from .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const idx = trimmed.indexOf('=');
            if (idx > -1) {
                const k = trimmed.substring(0, idx).trim();
                const v = trimmed.substring(idx + 1).trim();
                if (k && !process.env[k]) {
                    process.env[k] = v;
                }
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Initialize Database
const db = getDatabase();

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) { // 5MB limit
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                resolve(parsed);
            } catch (err) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || '127.0.0.1';
}

// Static Asset Dispatcher
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveStaticFile(req, res, pathname) {
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\' || safePath === '') safePath = 'index.html';

    const fullPath = path.join(__dirname, safePath);

    fs.stat(fullPath, (err, stats) => {
        if (err || !stats.isFile()) {
            const notFoundPage = path.join(__dirname, '404.html');
            if (fs.existsSync(notFoundPage)) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
                fs.createReadStream(notFoundPage).pipe(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
                res.end(`<h1>404 Not Found</h1><p>Cannot find ${pathname}</p>`);
            }
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600'
        });
        fs.createReadStream(fullPath).pipe(res);
    });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const corsHeaders = getCorsHeaders(req.headers);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;
    const method = req.method;

    // API & Health Routes
    if (pathname.startsWith('/api/') || pathname === '/health') {
        try {
            let body = {};
            if (['POST', 'PUT', 'PATCH'].includes(method)) {
                body = await parseJsonBody(req);
            }

            const result = await handleApiRequest({
                pathname,
                method,
                query,
                headers: req.headers,
                body,
                clientIp: getClientIp(req)
            });

            res.writeHead(result.statusCode, {
                'Content-Type': 'application/json',
                ...result.headers
            });
            res.end(JSON.stringify(result.body));
        } catch (apiError) {
            console.error('API Error:', apiError);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: apiError.message || 'Server error' }));
        }
        return;
    }

    // Static Assets
    serveStaticFile(req, res, pathname);
});

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        console.log(`\n======================================================`);
        console.log(`🚀 FitGear Pakistan (Local Dev Server) is Live!`);
        console.log(`📡 URL: http://${HOST}:${PORT} (bound to ${HOST})`);
        console.log(`💾 SQLite Database: ${getDbPath()}`);
        console.log(`👤 Admin Account: ${process.env.ADMIN_EMAIL || 'admin@fitgear.pk'}`);
        console.log(`🛒 Customer Account: customer@fitgear.pk / customer123`);
        console.log(`⚡ Netlify Serverless Function: netlify/functions/api.js ready`);
        console.log(`======================================================\n`);
    });

    function gracefulShutdown(signal) {
        console.log(`\nReceived ${signal}. Gracefully shutting down...`);
        try {
            if (db) {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
                db.close();
                console.log('SQLite database connection closed cleanly.');
            }
        } catch (err) {
            console.error('Error during database close:', err.message);
        }
        server.close(() => {
            console.log('HTTP server closed.');
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { server, handleApiRequest, getDatabase };
