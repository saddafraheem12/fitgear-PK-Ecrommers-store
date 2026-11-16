/**
 * FITGEAR PAKISTAN - CORE API ROUTER & CONTROLLER
 * Pure business logic handling all 28 API endpoints.
 * Usable by both standalone Node.js server and serverless Netlify Functions.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDatabase, getDbPath, hashPassword, verifyPassword } = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'fitgear_pk_super_secret_session_2026';

// In-Memory Token Cache (for fast lookup within same process/container)
const activeTokens = new Map();

function generateToken(user) {
    const userData = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        city: user.city,
        address: user.address,
        ts: Date.now()
    };

    // Create cryptographically signed, stateless token (HMAC-SHA256)
    // Works across cold starts and multiple concurrent serverless instances
    const payload = Buffer.from(JSON.stringify(userData)).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const token = `${payload}.${signature}`;

    activeTokens.set(token, userData);
    return token;
}

function getAuthUser(headers) {
    if (!headers) return null;
    const authHeader = headers['authorization'] || headers['Authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (headers['x-auth-token'] || headers['X-Auth-Token']) {
        token = headers['x-auth-token'] || headers['X-Auth-Token'];
    }

    if (!token) return null;

    // 1. Check in-memory cache
    if (activeTokens.has(token)) {
        return activeTokens.get(token);
    }

    // 2. Verify HMAC signature for stateless serverless requests
    if (token.includes('.')) {
        const parts = token.split('.');
        if (parts.length === 2) {
            const [payload, signature] = parts;
            const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
            
            let signaturesMatch = false;
            try {
                const bufA = Buffer.from(signature);
                const bufB = Buffer.from(expectedSig);
                signaturesMatch = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
            } catch (_) {
                signaturesMatch = false;
            }

            if (signaturesMatch) {
                try {
                    const userData = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
                    // Enforce 7-day token expiration
                    const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
                    if (userData.ts && (Date.now() - userData.ts > TOKEN_TTL_MS)) {
                        activeTokens.delete(token);
                        return null; // Expired token
                    }
                    activeTokens.set(token, userData);
                    return userData;
                } catch (_) {
                    return null;
                }
            }
        }
    }

    return null;
}

// In-Memory Sliding Window Rate Limiter
const rateLimitMap = new Map();
function checkRateLimit(ip, endpointKey, maxRequests, windowMs) {
    const now = Date.now();
    const key = `${ip || 'unknown'}:${endpointKey}`;
    let record = rateLimitMap.get(key);
    if (!record || now > record.resetTime) {
        rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
        return true;
    }
    if (record.count >= maxRequests) {
        return false;
    }
    record.count++;
    return true;
}

// Pakistani Payment Gateways Architecture
function getPaymentGateways() {
    return {
        cod: {
            id: 'cod',
            name: 'Cash on Delivery (COD)',
            status: 'active',
            type: 'offline',
            description: 'Pay cash to delivery rider at your doorstep. Operational across Pakistan.',
            is_configured: true
        },
        bank_transfer: {
            id: 'bank_transfer',
            name: 'Direct Bank Transfer / Raast',
            status: 'active',
            type: 'manual',
            description: 'Meezan Bank Raast transfer with manual verification on WhatsApp (+92 300 0000000).',
            bank_details: {
                bank: 'Meezan Bank Limited',
                title: 'FitGear Pakistan',
                iban: 'PK36MEZN0002840105829182'
            },
            is_configured: true
        },
        jazzcash: {
            id: 'jazzcash',
            name: 'JazzCash Mobile Account & Card',
            status: (process.env.JAZZCASH_MERCHANT_ID && process.env.JAZZCASH_PASSWORD) ? 'active' : 'unconfigured',
            type: 'gateway',
            description: 'Instant mobile account & card payments via JazzCash PGW.',
            is_configured: !!(process.env.JAZZCASH_MERCHANT_ID && process.env.JAZZCASH_PASSWORD && process.env.JAZZCASH_INTEGRITY_SALT),
            endpoint: process.env.NODE_ENV === 'production'
                ? 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/'
                : 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
            required_env: ['JAZZCASH_MERCHANT_ID', 'JAZZCASH_PASSWORD', 'JAZZCASH_INTEGRITY_SALT']
        },
        easypaisa: {
            id: 'easypaisa',
            name: 'EasyPaisa Wallet & OTC',
            status: (process.env.EASYPAISA_STORE_ID && process.env.EASYPAISA_HASH_KEY) ? 'active' : 'unconfigured',
            type: 'gateway',
            description: 'Instant payment via EasyPaisa MA & OTC tokens.',
            is_configured: !!(process.env.EASYPAISA_STORE_ID && process.env.EASYPAISA_HASH_KEY),
            endpoint: process.env.NODE_ENV === 'production'
                ? 'https://easypay.easypaisa.com.pk/easypay/Index.jsf'
                : 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf',
            required_env: ['EASYPAISA_STORE_ID', 'EASYPAISA_HASH_KEY']
        }
    };
}

const ALLOWED_ORIGINS = [
    'https://fitgear-pk.netlify.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8888',
    'http://127.0.0.1:8888',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
];

if (process.env.ALLOWED_ORIGINS) {
    const extra = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    ALLOWED_ORIGINS.push(...extra);
}

function getCorsHeaders(headers = {}) {
    const origin = headers['origin'] || headers['Origin'];
    let allowOrigin = '*';
    if (origin) {
        if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.netlify.app') || process.env.NODE_ENV !== 'production') {
            allowOrigin = origin;
        } else {
            allowOrigin = origin;
        }
    }
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, Origin, X-Requested-With, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Credentials': allowOrigin !== '*' ? 'true' : 'false',
        'Access-Control-Max-Age': '86400'
    };
}

/**
 * Main API Request Dispatcher
 * @param {Object} params
 * @param {string} params.pathname - URL path, e.g. '/api/products'
 * @param {string} params.method - HTTP method: 'GET', 'POST', etc.
 * @param {Object} [params.query] - Query parameters
 * @param {Object} [params.headers] - Request headers
 * @param {Object} [params.body] - Parsed JSON body
 * @param {string} [params.clientIp] - Client IP address
 * @returns {Promise<{ statusCode: number, headers: Object, body: Object }>}
 */
async function handleApiRequest({ pathname, method, query = {}, headers = {}, body = {}, clientIp = '127.0.0.1' }) {
    const cors = getCorsHeaders(headers);

    // Normalize pathname: extract query string if embedded in pathname, strip trailing slashes
    let rawPath = (pathname || '').trim();
    if (rawPath.includes('?')) {
        const [cleanPath, qs] = rawPath.split('?');
        rawPath = cleanPath;
        if (qs) {
            const parsed = new URLSearchParams(qs);
            for (const [k, v] of parsed.entries()) {
                if (query[k] === undefined) query[k] = v;
            }
        }
    }
    pathname = rawPath.replace(/\/+$/, '') || '/';

    // OPTIONS preflight
    if (method === 'OPTIONS') {
        return { statusCode: 204, headers: cors, body: {} };
    }

    const db = getDatabase();

    // 0. HEALTH CHECK ENDPOINTS
    if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
        try {
            db.prepare('SELECT 1').get();
            return {
                statusCode: 200,
                headers: cors,
                body: {
                    status: 'healthy',
                    service: 'FitGear Pakistan API (Netlify Functions Edition)',
                    timestamp: new Date().toISOString(),
                    uptime_seconds: Math.floor(process.uptime()),
                    database: 'connected',
                    environment: process.env.NODE_ENV || 'production'
                }
            };
        } catch (dbErr) {
            return {
                statusCode: 503,
                headers: cors,
                body: {
                    status: 'unhealthy',
                    service: 'FitGear Pakistan API',
                    error: 'Database check failed: ' + dbErr.message
                }
            };
        }
    }

    try {
        // 1. GET /api/categories
        if (pathname === '/api/categories' && method === 'GET') {
            const categories = db.prepare(`
                SELECT c.*, COUNT(p.id) as product_count
                FROM categories c
                LEFT JOIN products p ON p.category_slug = c.slug
                GROUP BY c.id
            `).all();
            return { statusCode: 200, headers: cors, body: { success: true, categories } };
        }

        // 2. GET /api/products
        if (pathname === '/api/products' && method === 'GET') {
            let sql = 'SELECT * FROM products WHERE 1=1';
            const params = [];

            const categoryFilter = query.category || query.cat;
            if (categoryFilter && categoryFilter !== 'all') {
                sql += ' AND category_slug = ?';
                params.push(categoryFilter);
            }

            if (query.flash_sale === '1' || query.flash_sale === 'true' || query.flash === '1') {
                sql += ' AND is_flash_sale = 1';
            }

            const searchFilter = query.search || query.q;
            if (searchFilter) {
                sql += ' AND (name LIKE ? OR description LIKE ?)';
                params.push(`%${searchFilter}%`, `%${searchFilter}%`);
            }

            if (query.max_price) {
                sql += ' AND price <= ?';
                params.push(Number(query.max_price));
            }

            // Sorting
            if (query.sort === 'price-low') {
                sql += ' ORDER BY price ASC';
            } else if (query.sort === 'price-high') {
                sql += ' ORDER BY price DESC';
            } else if (query.sort === 'name-asc') {
                sql += ' ORDER BY name ASC';
            } else if (query.sort === 'name-desc') {
                sql += ' ORDER BY name DESC';
            } else if (query.sort === 'popular') {
                sql += ' ORDER BY sold_count DESC';
            } else {
                sql += ' ORDER BY id ASC';
            }

            const products = db.prepare(sql).all(...params);
            return { statusCode: 200, headers: cors, body: { success: true, count: products.length, products } };
        }

        // 3. GET /api/products/:id
        if (pathname.match(/^\/api\/products\/\d+$/) && method === 'GET') {
            const id = pathname.split('/').pop();
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
            if (!product) {
                return { statusCode: 404, headers: cors, body: { success: false, error: 'Product not found' } };
            }

            const reviews = db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(id);
            const avgRatingRow = db.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE product_id = ?').get(id);

            product.specs = product.specs_json ? JSON.parse(product.specs_json) : {};
            product.reviews = reviews;
            product.avg_rating = avgRatingRow.avg_rating ? Number(avgRatingRow.avg_rating.toFixed(1)) : 5.0;
            product.reviews_count = avgRatingRow.count || 0;

            return { statusCode: 200, headers: cors, body: { success: true, product } };
        }

        // 4. POST /api/products (Admin create)
        if (pathname === '/api/products' && method === 'POST') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            if (!body.name || !body.price || !body.category_slug) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Missing required product fields' } };
            }

            const stmt = db.prepare(`
                INSERT INTO products (name, category_slug, price, original_price, stock_count, badge, image, description, specs_json, is_flash_sale, flash_discount_percent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                body.name,
                body.category_slug,
                Number(body.price),
                Number(body.original_price || body.price),
                Number(body.stock_count || 10),
                body.badge || 'New',
                body.image || 'images/dumbbell_set.jpg',
                body.description || '',
                JSON.stringify(body.specs || {}),
                body.is_flash_sale ? 1 : 0,
                Number(body.flash_discount_percent || 0)
            );

            return { statusCode: 201, headers: cors, body: { success: true, message: 'Product created successfully', productId: result.lastInsertRowid } };
        }

        // 5. PUT /api/products/:id (Admin update)
        if (pathname.match(/^\/api\/products\/\d+$/) && method === 'PUT') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const id = pathname.split('/').pop();
            const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
            if (!existing) {
                return { statusCode: 404, headers: cors, body: { success: false, error: 'Product not found' } };
            }

            const name = body.name !== undefined ? body.name : existing.name;
            const category_slug = body.category_slug !== undefined ? body.category_slug : existing.category_slug;
            const price = body.price !== undefined ? Number(body.price) : existing.price;
            const original_price = body.original_price !== undefined ? Number(body.original_price) : existing.original_price;
            const stock_count = body.stock_count !== undefined ? Number(body.stock_count) : existing.stock_count;
            const badge = body.badge !== undefined ? body.badge : existing.badge;
            const description = body.description !== undefined ? body.description : existing.description;
            const is_flash_sale = body.is_flash_sale !== undefined ? (body.is_flash_sale ? 1 : 0) : existing.is_flash_sale;
            const flash_discount_percent = body.flash_discount_percent !== undefined ? Number(body.flash_discount_percent) : existing.flash_discount_percent;

            db.prepare(`
                UPDATE products
                SET name = ?, category_slug = ?, price = ?, original_price = ?, stock_count = ?, badge = ?, description = ?, is_flash_sale = ?, flash_discount_percent = ?
                WHERE id = ?
            `).run(
                name,
                category_slug,
                price,
                original_price,
                stock_count,
                badge,
                description,
                is_flash_sale,
                flash_discount_percent,
                id
            );

            return { statusCode: 200, headers: cors, body: { success: true, message: 'Product updated successfully' } };
        }

        // 6. DELETE /api/products/:id (Admin delete)
        if (pathname.match(/^\/api\/products\/\d+$/) && method === 'DELETE') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const id = pathname.split('/').pop();
            db.prepare('DELETE FROM products WHERE id = ?').run(id);
            return { statusCode: 200, headers: cors, body: { success: true, message: 'Product deleted' } };
        }

        // 7. GET /api/vouchers
        if (pathname === '/api/vouchers' && method === 'GET') {
            const vouchers = db.prepare('SELECT * FROM vouchers ORDER BY min_spend ASC').all();
            return { statusCode: 200, headers: cors, body: { success: true, vouchers } };
        }

        // 8. POST /api/vouchers/validate
        if (pathname === '/api/vouchers/validate' && method === 'POST') {
            const code = (body.code || '').trim().toUpperCase();
            const subtotal = Number(body.subtotal !== undefined ? body.subtotal : (body.cart_total !== undefined ? body.cart_total : 0)) || 0;

            const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
            if (!voucher) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Invalid voucher code' } };
            }

            if (subtotal < voucher.min_spend) {
                return {
                    statusCode: 400,
                    headers: cors,
                    body: {
                        success: false,
                        error: `Voucher requires a minimum spend of PKR ${voucher.min_spend.toLocaleString('en-PK')}`
                    }
                };
            }

            const discountAmount = voucher.discount_type === 'percent'
                ? Math.round(subtotal * voucher.discount_value)
                : voucher.discount_value;

            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    voucher: {
                        code: voucher.code,
                        title: voucher.title,
                        discount_type: voucher.discount_type,
                        discount_value: voucher.discount_value,
                        discount_amount: discountAmount
                    }
                }
            };
        }

        // 9. POST /api/auth/register
        if (pathname === '/api/auth/register' && method === 'POST') {
            const name = (body.name || '').trim();
            const email = (body.email || '').trim().toLowerCase();
            const phone = (body.phone || '').trim();
            const password = body.password || '';

            if (!name || !email || !password || password.length < 6) {
                return {
                    statusCode: 400,
                    headers: cors,
                    body: { success: false, error: 'Please provide valid name, email, and password (min 6 characters)' }
                };
            }

            const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
            if (existing) {
                return { statusCode: 409, headers: cors, body: { success: false, error: 'An account with this email already exists' } };
            }

            const result = db.prepare(`
                INSERT INTO users (name, email, phone, password_hash, role, city, address)
                VALUES (?, ?, ?, ?, 'customer', ?, ?)
            `).run(name, email, phone, hashPassword(password), body.city || 'Karachi', body.address || '');

            const newUser = { id: result.lastInsertRowid, name, email, phone, role: 'customer' };
            const token = generateToken(newUser);

            return { statusCode: 201, headers: cors, body: { success: true, token, user: newUser } };
        }

        // 10. POST /api/auth/login
        if (pathname === '/api/auth/login' && method === 'POST') {
            if (!checkRateLimit(clientIp, 'auth_login', 15, 60000)) {
                return { statusCode: 429, headers: cors, body: { success: false, error: 'Too many login attempts. Please wait 1 minute before trying again.' } };
            }

            const email = (body.email || '').trim().toLowerCase();
            const password = body.password || '';

            const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
            if (!user || !verifyPassword(password, user.password_hash)) {
                return { statusCode: 401, headers: cors, body: { success: false, error: 'Invalid email or password' } };
            }

            const token = generateToken(user);
            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        phone: user.phone,
                        role: user.role,
                        city: user.city,
                        address: user.address
                    }
                }
            };
        }

        // 11. GET /api/auth/me
        if (pathname === '/api/auth/me' && method === 'GET') {
            const user = getAuthUser(headers);
            if (!user) {
                return { statusCode: 401, headers: cors, body: { success: false, error: 'Not authenticated' } };
            }
            return { statusCode: 200, headers: cors, body: { success: true, user } };
        }

        // 11b. PATCH /api/auth/profile
        if (pathname === '/api/auth/profile' && method === 'PATCH') {
            const user = getAuthUser(headers);
            if (!user) {
                return { statusCode: 401, headers: cors, body: { success: false, error: 'Authentication required' } };
            }

            const name = (body.name || user.name).trim();
            const phone = (body.phone || user.phone).trim();
            const city = (body.city || user.city || 'Karachi').trim();
            const address = (body.address || user.address || '').trim();

            db.prepare(`
                UPDATE users
                SET name = ?, phone = ?, city = ?, address = ?
                WHERE id = ?
            `).run(name, phone, city, address, user.id);

            user.name = name;
            user.phone = phone;
            user.city = city;
            user.address = address;

            return { statusCode: 200, headers: cors, body: { success: true, message: 'Profile updated in database successfully', user } };
        }

        // 12. POST /api/orders (Create Real Database Order)
        if (pathname === '/api/orders' && method === 'POST') {
            if (!checkRateLimit(clientIp, 'orders', 30, 60000)) {
                return { statusCode: 429, headers: cors, body: { success: false, error: 'Too many order attempts. Please slow down.' } };
            }

            const items = body.items || [];
            if (items.length === 0) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Your cart is empty' } };
            }

            const user = getAuthUser(headers);
            const customerName = (body.customer_name || (user ? user.name : '')).trim();
            const customerPhone = (body.customer_phone || (user ? user.phone : '')).trim();
            const customerEmail = (body.customer_email || (user ? user.email : '')).trim();
            const address = (body.shipping_address || body.address || '').trim();
            const city = (body.city || 'Karachi').trim();
            const province = (body.province || 'Sindh').trim();
            const postalCode = body.postal_code || '';
            const paymentMethod = (body.payment_method || 'COD').toUpperCase();

            if (!customerName || !customerPhone || !address) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Please provide full name, phone, and delivery address' } };
            }

            db.exec('BEGIN IMMEDIATE');
            try {
                let subtotal = 0;
                const validatedItems = [];

                for (const item of items) {
                    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
                    if (!product) {
                        throw new Error(`Product SKU #${item.id} not found in database.`);
                    }
                    if (product.stock_count < item.quantity) {
                        throw new Error(`Stock conflict: "${product.name}" only has ${product.stock_count} units available (requested ${item.quantity}).`);
                    }
                    const lineTotal = product.price * item.quantity;
                    subtotal += lineTotal;
                    validatedItems.push({
                        product_id: product.id,
                        product_name: product.name,
                        product_image: product.image,
                        unit_price: product.price,
                        quantity: item.quantity,
                        line_total: lineTotal
                    });
                }

                const shippingFee = subtotal >= 5000 ? 0 : 500;
                let discountAmount = Number(body.discount_amount) || 0;
                const totalAmount = Math.max(0, subtotal - discountAmount + shippingFee);

                // Check for duplicate order submitted within the last 30 seconds
                const recentDuplicate = db.prepare(`
                    SELECT id, order_number FROM orders 
                    WHERE (customer_phone = ? OR (customer_email != '' AND customer_email = ?))
                      AND total_amount = ? 
                      AND datetime(created_at) >= datetime('now', '-30 seconds')
                `).get(customerPhone, customerEmail, totalAmount);

                if (recentDuplicate) {
                    throw new Error(`Duplicate order detected: An identical order (${recentDuplicate.order_number}) was submitted within the last 30 seconds.`);
                }

                const orderNumber = 'PK-FG-' + Math.floor(100000 + Math.random() * 900000);
                const trackingNumber = 'TRAX-PK-' + Math.floor(1000000 + Math.random() * 9000000);

                const orderResult = db.prepare(`
                    INSERT INTO orders (
                        order_number, tracking_number, user_id, customer_name, customer_phone, customer_email,
                        shipping_address, city, province, postal_code, payment_method, subtotal, discount_amount,
                        shipping_fee, total_amount, order_status, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Processing', ?)
                `).run(
                    orderNumber,
                    trackingNumber,
                    user ? user.id : null,
                    customerName,
                    customerPhone,
                    customerEmail,
                    address,
                    city,
                    province,
                    postalCode,
                    paymentMethod,
                    subtotal,
                    discountAmount,
                    shippingFee,
                    totalAmount,
                    body.notes || ''
                );

                const orderId = orderResult.lastInsertRowid;

                const insertItem = db.prepare(`
                    INSERT INTO order_items (order_id, product_id, product_name, product_image, unit_price, quantity, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                const updateStock = db.prepare(`
                    UPDATE products
                    SET stock_count = stock_count - ?, sold_count = sold_count + ?
                    WHERE id = ? AND stock_count >= ?
                `);

                for (const item of validatedItems) {
                    insertItem.run(orderId, item.product_id, item.product_name, item.product_image, item.unit_price, item.quantity, item.line_total);
                    const stockResult = updateStock.run(item.quantity, item.quantity, item.product_id, item.quantity);
                    if (stockResult.changes === 0) {
                        throw new Error(`Inventory race condition: "${item.product_name}" was just reserved by another customer.`);
                    }
                }

                db.exec('COMMIT');

                return {
                    statusCode: 201,
                    headers: cors,
                    body: {
                        success: true,
                        order_id: orderId,
                        order_number: orderNumber,
                        tracking_number: trackingNumber,
                        customer_name: customerName,
                        total_amount: totalAmount,
                        order_status: 'Processing',
                        message: 'Order created and persisted in database successfully!'
                    }
                };
            } catch (orderErr) {
                try { db.exec('ROLLBACK'); } catch (_) {}
                return { statusCode: 400, headers: cors, body: { success: false, error: orderErr.message } };
            }
        }

        // 13. GET /api/orders (Listing for current user or admin)
        if (pathname === '/api/orders' && method === 'GET') {
            const user = getAuthUser(headers);
            let orders = [];

            if (user && user.role === 'admin') {
                orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
            } else if (user) {
                orders = db.prepare('SELECT * FROM orders WHERE user_id = ? OR customer_email = ? ORDER BY id DESC').all(user.id, user.email);
            } else {
                return { statusCode: 401, headers: cors, body: { success: false, error: 'Authentication required to view order history' } };
            }

            const getItemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
            orders.forEach(o => {
                o.items = getItemStmt.all(o.id);
            });

            return { statusCode: 200, headers: cors, body: { success: true, count: orders.length, orders } };
        }

        // 14. GET /api/orders/track/:query
        if (pathname.startsWith('/api/orders/track/') && method === 'GET') {
            const searchVal = decodeURIComponent(pathname.replace('/api/orders/track/', '')).trim();
            const order = db.prepare(`
                SELECT * FROM orders
                WHERE order_number = ? OR tracking_number = ? OR customer_phone = ?
                ORDER BY id DESC LIMIT 1
            `).get(searchVal, searchVal, searchVal);

            if (!order) {
                return { statusCode: 404, headers: cors, body: { success: false, error: `No active order found for query "${searchVal}"` } };
            }

            order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
            return { statusCode: 200, headers: cors, body: { success: true, order } };
        }

        // 15. PATCH /api/orders/:id/status
        if (pathname.match(/^\/api\/orders\/\d+\/status$/) && method === 'PATCH') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const id = pathname.split('/')[3];
            const newStatus = (body.status || body.order_status || '').trim();

            const allowedStatuses = ['Pending', 'Processing', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
            if (!allowedStatuses.includes(newStatus)) {
                return { statusCode: 400, headers: cors, body: { success: false, error: `Invalid status "${newStatus}". Allowed: ${allowedStatuses.join(', ')}` } };
            }

            db.exec('BEGIN IMMEDIATE');
            try {
                const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
                if (!order) {
                    db.exec('ROLLBACK');
                    return { statusCode: 404, headers: cors, body: { success: false, error: 'Order not found' } };
                }

                const oldStatus = order.order_status;
                const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);

                if (oldStatus !== 'Cancelled' && newStatus === 'Cancelled') {
                    const restoreStmt = db.prepare(`
                        UPDATE products
                        SET stock_count = stock_count + ?, sold_count = MAX(0, sold_count - ?)
                        WHERE id = ?
                    `);
                    for (const item of orderItems) {
                        restoreStmt.run(item.quantity, item.quantity, item.product_id);
                    }
                }

                if (oldStatus === 'Cancelled' && newStatus !== 'Cancelled') {
                    for (const item of orderItems) {
                        const p = db.prepare('SELECT id, name, stock_count FROM products WHERE id = ?').get(item.product_id);
                        if (!p || p.stock_count < item.quantity) {
                            throw new Error(`Cannot reactivate order: Insufficient stock for "${item.product_name}". Available: ${p ? p.stock_count : 0}, Required: ${item.quantity}`);
                        }
                    }
                    const deductStmt = db.prepare(`
                        UPDATE products
                        SET stock_count = stock_count - ?, sold_count = sold_count + ?
                        WHERE id = ? AND stock_count >= ?
                    `);
                    for (const item of orderItems) {
                        const resStock = deductStmt.run(item.quantity, item.quantity, item.product_id, item.quantity);
                        if (resStock.changes === 0) {
                            throw new Error(`Stock race condition while reactivating order for "${item.product_name}".`);
                        }
                    }
                }

                db.prepare('UPDATE orders SET order_status = ? WHERE id = ?').run(newStatus, id);
                db.exec('COMMIT');

                return {
                    statusCode: 200,
                    headers: cors,
                    body: {
                        success: true,
                        order_id: Number(id),
                        previous_status: oldStatus,
                        new_status: newStatus,
                        message: `Order #${id} status updated from ${oldStatus} to ${newStatus}`
                    }
                };
            } catch (statusErr) {
                try { db.exec('ROLLBACK'); } catch (_) {}
                return { statusCode: 400, headers: cors, body: { success: false, error: statusErr.message } };
            }
        }

        // 15b. GET /api/reviews
        if (pathname === '/api/reviews' && method === 'GET') {
            let sql = `
                SELECT r.*, p.name AS product_name
                FROM reviews r
                LEFT JOIN products p ON r.product_id = p.id
            `;
            const params = [];
            if (query && (query.product_id || query.productId)) {
                sql += ' WHERE r.product_id = ?';
                params.push(Number(query.product_id || query.productId));
            }
            sql += ' ORDER BY r.id DESC LIMIT 20';
            const reviews = db.prepare(sql).all(...params);
            return { statusCode: 200, headers: cors, body: { success: true, reviews } };
        }

        // 16. POST /api/reviews
        if (pathname === '/api/reviews' && method === 'POST') {
            const productId = Number(body.product_id);
            const name = (body.user_name || '').trim();
            const city = (body.user_city || 'Pakistan').trim();
            const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));
            const comment = (body.comment || '').trim();

            if (!productId || !name || !comment) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Please provide name, rating, and feedback comment' } };
            }

            db.prepare(`
                INSERT INTO reviews (product_id, user_name, user_city, rating, comment)
                VALUES (?, ?, ?, ?, ?)
            `).run(productId, name, city, rating, comment);

            return { statusCode: 201, headers: cors, body: { success: true, message: 'Review submitted and saved to database!' } };
        }

        // 17. GET /api/admin/metrics
        if (pathname === '/api/admin/metrics' && method === 'GET') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const totalSales = db.prepare("SELECT SUM(total_amount) as total FROM orders WHERE order_status != 'Cancelled'").get();
            const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get();
            const totalCustomers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'customer'").get();
            const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products').get();
            const lowStockProducts = db.prepare('SELECT * FROM products WHERE stock_count <= 8 ORDER BY stock_count ASC').all();
            const recentOrders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();

            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    metrics: {
                        revenue: totalSales.total || 0,
                        orders_count: totalOrders.count || 0,
                        customers_count: totalCustomers.count || 0,
                        products_count: totalProducts.count || 0,
                        low_stock: lowStockProducts,
                        recent_orders: recentOrders
                    }
                }
            };
        }

        // 17b. GET /api/admin/customers
        if (pathname === '/api/admin/customers' && method === 'GET') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const customers = db.prepare(`
                SELECT u.id, u.name, u.email, u.phone, u.city, u.address, u.role, u.created_at,
                       COUNT(o.id) as orders_count,
                       COALESCE(SUM(o.total_amount), 0) as total_spent
                FROM users u
                LEFT JOIN orders o ON (o.user_id = u.id OR o.customer_email = u.email)
                GROUP BY u.id
                ORDER BY u.id DESC
            `).all();

            return { statusCode: 200, headers: cors, body: { success: true, count: customers.length, customers } };
        }

        // 17c. GET /api/admin/system
        if (pathname === '/api/admin/system' && method === 'GET') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const actualDbPath = getDbPath();
            let dbSizeKb = 0;
            try {
                if (fs.existsSync(actualDbPath)) {
                    dbSizeKb = Math.round(fs.statSync(actualDbPath).size / 1024);
                }
            } catch (_) {}

            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    system: {
                        node_version: process.version,
                        platform: process.platform,
                        uptime_seconds: Math.round(process.uptime()),
                        db_size_kb: dbSizeKb,
                        db_path: actualDbPath,
                        gateways: getPaymentGateways()
                    }
                }
            };
        }

        // 18. POST /api/contact
        if (pathname === '/api/contact' && method === 'POST') {
            if (!checkRateLimit(clientIp, 'contact', 10, 60000)) {
                return { statusCode: 429, headers: cors, body: { success: false, error: 'Too many contact inquiries submitted. Please wait a minute.' } };
            }

            const name = (body.name || '').trim();
            const phone = (body.phone || '').trim();
            const email = (body.email || '').trim();
            const subject = (body.subject || 'General Inquiry').trim();
            const message = (body.message || '').trim();

            if (!name || !phone || !email || !message) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Please provide name, phone, email, and inquiry message' } };
            }

            const result = db.prepare(`
                INSERT INTO inquiries (name, phone, email, subject, message, status)
                VALUES (?, ?, ?, ?, ?, 'New')
            `).run(name, phone, email, subject, message);

            return {
                statusCode: 201,
                headers: cors,
                body: {
                    success: true,
                    inquiry_id: result.lastInsertRowid,
                    message: `Inquiry #INQ-${result.lastInsertRowid} recorded in FitGear support database. Our Karachi team will contact you via WhatsApp/Phone within 24 hours.`,
                    email_forwarded: !!(process.env.SMTP_HOST && process.env.SMTP_USER)
                }
            };
        }

        // 19. GET /api/admin/inquiries
        if (pathname === '/api/admin/inquiries' && method === 'GET') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const inquiries = db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 50').all();
            return { statusCode: 200, headers: cors, body: { success: true, count: inquiries.length, inquiries } };
        }

        // 20. PATCH /api/admin/inquiries/:id/status
        if (pathname.match(/^\/api\/admin\/inquiries\/\d+\/status$/) && method === 'PATCH') {
            const user = getAuthUser(headers);
            if (!user || user.role !== 'admin') {
                return { statusCode: 403, headers: cors, body: { success: false, error: 'Admin authorization required' } };
            }

            const id = pathname.split('/')[4];
            const newStatus = body.status || 'Resolved';

            db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(newStatus, id);
            return { statusCode: 200, headers: cors, body: { success: true, message: `Inquiry #${id} marked as ${newStatus}` } };
        }

        // 21. GET /api/payment/gateways
        if (pathname === '/api/payment/gateways' && method === 'GET') {
            const gateways = getPaymentGateways();
            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    gateways: Object.values(gateways),
                    active_methods: ['cod', 'bank_transfer'],
                    notice: 'Cash on Delivery and Bank Transfer are operational. JazzCash and EasyPaisa require merchant credentials in .env.'
                }
            };
        }

        // 22. POST /api/payment/initiate
        if (pathname === '/api/payment/initiate' && method === 'POST') {
            const gatewayId = (body.gateway || 'cod').toLowerCase();
            const orderId = body.order_id;

            const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
            if (!order) {
                return { statusCode: 404, headers: cors, body: { success: false, error: 'Order not found for payment initialization' } };
            }

            const gateways = getPaymentGateways();
            const gw = gateways[gatewayId];
            if (!gw) {
                return { statusCode: 400, headers: cors, body: { success: false, error: 'Unsupported payment method requested' } };
            }

            if (gatewayId === 'cod' || gatewayId === 'bank_transfer') {
                return {
                    statusCode: 200,
                    headers: cors,
                    body: {
                        success: true,
                        gateway: gatewayId,
                        status: 'confirmed',
                        order_number: order.order_number,
                        instructions: gatewayId === 'cod'
                            ? 'Keep exact cash ready for rider.'
                            : 'Transfer amount via Raast to Meezan Bank PK36MEZN0002840105829182 and share receipt on WhatsApp.'
                    }
                };
            }

            if (!gw.is_configured) {
                return {
                    statusCode: 400,
                    headers: cors,
                    body: {
                        success: false,
                        gateway: gatewayId,
                        error: `Payment gateway ${gw.name} is currently unconfigured. Real merchant credentials (${gw.required_env.join(', ')}) must be configured before initiating live charges. Please select Cash on Delivery or Bank Transfer.`,
                        is_configured: false
                    }
                };
            }

            const txnRef = `TXN-${order.order_number}-${Date.now()}`;
            let payload = {};

            if (gatewayId === 'jazzcash') {
                payload = {
                    pp_Version: '1.1',
                    pp_TxnType: 'MWALLET',
                    pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
                    pp_Password: process.env.JAZZCASH_PASSWORD,
                    pp_TxnRefNo: txnRef,
                    pp_Amount: order.total_amount * 100,
                    pp_TxnCurrency: 'PKR',
                    pp_ReturnURL: process.env.JAZZCASH_RETURN_URL,
                    pp_BillReference: order.order_number,
                    pp_Description: `FitGear Order ${order.order_number}`
                };
                const sortedFields = Object.keys(payload).sort().map(k => payload[k]).join('&');
                payload.pp_SecureHash = crypto.createHmac('sha256', process.env.JAZZCASH_INTEGRITY_SALT || '').update(sortedFields).digest('hex').toUpperCase();
            }

            return {
                statusCode: 200,
                headers: cors,
                body: {
                    success: true,
                    gateway: gatewayId,
                    endpoint: gw.endpoint,
                    payload,
                    txn_ref: txnRef
                }
            };
        }

        // 23. POST /api/payment/callback/:gateway (IPN Webhook)
        if (pathname.startsWith('/api/payment/callback/') && method === 'POST') {
            const gateway = pathname.split('/').pop().toLowerCase();

            // 1. JazzCash IPN Verification
            if (gateway === 'jazzcash') {
                const receivedHash = body.pp_SecureHash;
                const integritySalt = process.env.JAZZCASH_INTEGRITY_SALT;

                // When integrity salt is configured, strictly enforce HMAC-SHA256 signature verification
                if (integritySalt) {
                    if (!receivedHash) {
                        return { statusCode: 400, headers: cors, body: { success: false, error: 'Missing pp_SecureHash signature in webhook payload' } };
                    }
                    const sortedKeys = Object.keys(body).filter(k => k !== 'pp_SecureHash' && body[k] !== '' && body[k] !== null && body[k] !== undefined).sort();
                    const hashString = sortedKeys.map(k => String(body[k])).join('&');
                    const calculatedHash = crypto.createHmac('sha256', integritySalt).update(hashString).digest('hex').toUpperCase();

                    let signaturesMatch = false;
                    try {
                        const bufA = Buffer.from(receivedHash.toUpperCase());
                        const bufB = Buffer.from(calculatedHash);
                        signaturesMatch = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
                    } catch (_) {
                        signaturesMatch = false;
                    }

                    if (!signaturesMatch) {
                        return { statusCode: 403, headers: cors, body: { success: false, error: 'JazzCash HMAC signature verification failed' } };
                    }
                }

                if (body.pp_ResponseCode === '000' && body.pp_BillReference) {
                    const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(body.pp_BillReference);
                    if (!order) {
                        return { statusCode: 404, headers: cors, body: { success: false, error: 'Order not found for payment confirmation' } };
                    }

                    // Amount validation (JazzCash sends amount in paisas: PKR * 100)
                    if (body.pp_Amount && Number(body.pp_Amount) !== (order.total_amount * 100)) {
                        return { statusCode: 400, headers: cors, body: { success: false, error: `Payment amount mismatch: expected ${order.total_amount * 100} paisas, got ${body.pp_Amount}` } };
                    }

                    // Replay protection: Check if already verified
                    if (order.notes && order.notes.includes('Verified JazzCash IPN')) {
                        return { statusCode: 200, headers: cors, body: { success: true, message: 'Payment already processed (idempotent duplicate)' } };
                    }

                    const txnRef = body.pp_TxnRefNo || body.pp_RetreivalReferenceNo || 'N/A';
                    db.prepare("UPDATE orders SET order_status = 'Processing', notes = COALESCE(notes, '') || ' [Verified JazzCash IPN: Txn ' || ? || ']' WHERE order_number = ?").run(txnRef, body.pp_BillReference);
                    return { statusCode: 200, headers: cors, body: { success: true, message: 'JazzCash payment confirmed and order updated', txn_ref: txnRef } };
                }

                return { statusCode: 200, headers: cors, body: { success: true, message: 'JazzCash webhook received' } };
            }

            // 2. EasyPaisa IPN Verification
            if (gateway === 'easypaisa') {
                const hashKey = process.env.EASYPAISA_HASH_KEY;
                if (hashKey && body.hashValue) {
                    const calcHash = crypto.createHmac('sha256', hashKey).update(String(body.orderRefNum || '')).digest('hex');
                    if (calcHash !== body.hashValue) {
                        return { statusCode: 403, headers: cors, body: { success: false, error: 'EasyPaisa HMAC signature verification failed' } };
                    }
                }

                if (body.authStatus === '0000' && body.orderRefNum) {
                    const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(body.orderRefNum);
                    if (!order) {
                        return { statusCode: 404, headers: cors, body: { success: false, error: 'Order not found for EasyPaisa confirmation' } };
                    }

                    // Replay protection
                    if (order.notes && order.notes.includes('Verified EasyPaisa IPN')) {
                        return { statusCode: 200, headers: cors, body: { success: true, message: 'Payment already processed (idempotent duplicate)' } };
                    }

                    // Amount validation (if amount provided)
                    if (body.amount && Number(body.amount) !== order.total_amount) {
                        return { statusCode: 400, headers: cors, body: { success: false, error: `EasyPaisa amount mismatch: expected PKR ${order.total_amount}, got ${body.amount}` } };
                    }

                    const txnRef = body.transactionRefNumber || 'N/A';
                    db.prepare("UPDATE orders SET order_status = 'Processing', notes = COALESCE(notes, '') || ' [Verified EasyPaisa IPN: Txn ' || ? || ']' WHERE order_number = ?").run(txnRef, body.orderRefNum);
                    return { statusCode: 200, headers: cors, body: { success: true, message: 'EasyPaisa payment confirmed and order updated', txn_ref: txnRef } };
                }

                return { statusCode: 200, headers: cors, body: { success: true, message: 'EasyPaisa webhook received' } };
            }

            // 3. Generic Gateway Webhook Fallback
            return { statusCode: 200, headers: cors, body: { success: true, message: `Webhook received for ${gateway}` } };
        }

        // Route Not Found
        return { statusCode: 404, headers: cors, body: { success: false, error: `API endpoint "${pathname}" not found` } };

    } catch (apiError) {
        console.error('API Error:', apiError);
        return { statusCode: 500, headers: cors, body: { success: false, error: apiError.message || 'Server error' } };
    }
}

module.exports = {
    handleApiRequest,
    getCorsHeaders,
    generateToken,
    getAuthUser
};
