/**
 * FITGEAR PAKISTAN - NETLIFY SERVERLESS FUNCTION HANDLER
 * Bridges Netlify Functions (AWS Lambda / Web Fetch API) to FitGear Core API Router.
 * Automatically adapts between Netlify Functions v1 (AWS Lambda event) and v2 (Web standard Request).
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

function isFetchRequest(obj) {
    return !!(
        obj &&
        (typeof Request !== 'undefined' && obj instanceof Request) ||
        (typeof obj?.headers?.entries === 'function' && typeof obj?.text === 'function')
    );
}

/**
 * Netlify Functions v1 (AWS Lambda Event) Execution Path
 */
async function handleLambdaEvent(event = {}, context = {}) {
    try {
        const method = (event.httpMethod || 'GET').toUpperCase();
        const pathname = normalizePath(event.path || '');
        const query = event.queryStringParameters || {};
        const headers = event.headers || {};

        if (method === 'OPTIONS') {
            return {
                statusCode: 204,
                headers: getCorsHeaders(headers),
                body: ''
            };
        }

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
                } catch (_) {
                    try {
                        const params = new URLSearchParams(rawString);
                        body = {};
                        for (const [k, v] of params.entries()) {
                            body[k] = v;
                        }
                    } catch (parseErr) {
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
}

/**
 * Netlify Functions v2 (Web Standard Fetch Request / Response) Execution Path
 */
async function handleFetchRequest(req, context = {}) {
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
        console.error('[Netlify Function Fetch Error]:', err);
        return new Response(JSON.stringify({ success: false, error: err.message || 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Universal Handler: Autodetects whether invocation is Lambda Event or Web Request.
 */
async function universalHandler(arg1, arg2) {
    if (isFetchRequest(arg1)) {
        return handleFetchRequest(arg1, arg2);
    }
    return handleLambdaEvent(arg1, arg2);
}

exports.handler = universalHandler;
exports.default = universalHandler;
module.exports = universalHandler;
module.exports.handler = universalHandler;
module.exports.default = universalHandler;
