/**
 * FITGEAR PAKISTAN - NETLIFY SERVERLESS FUNCTION HANDLER
 * Bridges Netlify Functions (AWS Lambda / Fetch API) to FitGear Core API Router.
 * Supports both Netlify Functions v1 (exports.handler) and v2 (default export).
 */

const { handleApiRequest, getCorsHeaders } = require('../../backend/router');

function normalizePath(rawPath = '') {
    let p = rawPath;

    // Remove /.netlify/functions/api prefix if present
    const prefix = '/.netlify/functions/api';
    if (p.startsWith(prefix)) {
        p = p.substring(prefix.length) || '/';
    }

    // Ensure pathname begins with /api if it doesn't already, except for /health
    if (p === '/health' || p === '/api/health') {
        return p;
    }

    if (!p.startsWith('/api')) {
        p = '/api' + (p.startsWith('/') ? p : '/' + p);
    }

    return p;
}

/**
 * Netlify Functions v1 / AWS Lambda Handler
 */
exports.handler = async (event, context) => {
    try {
        const method = (event.httpMethod || 'GET').toUpperCase();
        const pathname = normalizePath(event.path || '');
        const query = event.queryStringParameters || {};
        const headers = event.headers || {};

        // OPTIONS preflight
        if (method === 'OPTIONS') {
            return {
                statusCode: 204,
                headers: getCorsHeaders(headers),
                body: ''
            };
        }

        // Parse request body (JSON and application/x-www-form-urlencoded)
        let body = {};
        if (event.body) {
            const contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
            const rawString = event.isBase64Encoded
                ? Buffer.from(event.body, 'base64').toString('utf8')
                : event.body;

            if (contentType.includes('application/x-www-form-urlencoded')) {
                const params = new URLSearchParams(rawString);
                body = {};
                for (const [k, v] of params.entries()) {
                    body[k] = v;
                }
            } else {
                try {
                    body = rawString ? JSON.parse(rawString) : {};
                } catch (jsonErr) {
                    try {
                        const params = new URLSearchParams(rawString);
                        body = {};
                        for (const [k, v] of params.entries()) {
                            body[k] = v;
                        }
                    } catch (_) {
                        return {
                            statusCode: 400,
                            headers: { 'Content-Type': 'application/json', ...getCorsHeaders(headers) },
                            body: JSON.stringify({ success: false, error: 'Invalid request body format' })
                        };
                    }
                }
            }
        }

        const clientIp = headers['client-ip'] || (headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : '127.0.0.1');

        const result = await handleApiRequest({
            pathname,
            method,
            query,
            headers,
            body,
            clientIp
        });

        return {
            statusCode: result.statusCode,
            headers: {
                'Content-Type': 'application/json',
                ...result.headers
            },
            body: JSON.stringify(result.body)
        };
    } catch (err) {
        console.error('[Netlify Function Handler Error]:', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json', ...getCorsHeaders(event?.headers) },
            body: JSON.stringify({ success: false, error: err.message || 'Internal server error' })
        };
    }
};

/**
 * Netlify Functions v2 (Modern Web Fetch Request / Response)
 */
exports.default = async (req, context) => {
    try {
        const url = new URL(req.url);
        const pathname = normalizePath(url.pathname);
        const method = req.method.toUpperCase();

        const headers = {};
        for (const [k, v] of req.headers.entries()) {
            headers[k.toLowerCase()] = v;
        }

        if (method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: getCorsHeaders(headers)
            });
        }

        const query = {};
        for (const [k, v] of url.searchParams.entries()) {
            query[k] = v;
        }

        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
            try {
                const text = await req.text();
                const contentType = (headers['content-type'] || '').toLowerCase();
                if (contentType.includes('application/x-www-form-urlencoded')) {
                    const params = new URLSearchParams(text);
                    body = {};
                    for (const [k, v] of params.entries()) {
                        body[k] = v;
                    }
                } else {
                    body = text ? JSON.parse(text) : {};
                }
            } catch (_) {
                return new Response(JSON.stringify({ success: false, error: 'Invalid request body format' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(headers) }
                });
            }
        }

        const clientIp = context?.ip || headers['client-ip'] || (headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : '127.0.0.1');

        const result = await handleApiRequest({
            pathname,
            method,
            query,
            headers,
            body,
            clientIp
        });

        return new Response(JSON.stringify(result.body), {
            status: result.statusCode,
            headers: {
                'Content-Type': 'application/json',
                ...result.headers
            }
        });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message || 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
