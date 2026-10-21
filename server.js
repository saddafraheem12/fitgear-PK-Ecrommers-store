/**
 * FITGEAR PAKISTAN - DATABASE-BACKED E-COMMERCE SERVER
 * Inspired by Daraz Pakistan
 * Powered by Node.js native HTTP, SQLite (node:sqlite), and Web Standards
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

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
const DB_PATH = process.env.DB_PATH ? path.resolve(__dirname, process.env.DB_PATH) : path.join(__dirname, 'fitgear.sqlite');

// --- 1. DATABASE INITIALIZATION & SCHEMA ---
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'customer',
        city TEXT,
        address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        image TEXT,
        description TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category_slug TEXT NOT NULL,
        price INTEGER NOT NULL,
        original_price INTEGER NOT NULL,
        stock_count INTEGER NOT NULL DEFAULT 15,
        sold_count INTEGER NOT NULL DEFAULT 0,
        badge TEXT DEFAULT 'Hot',
        image TEXT NOT NULL,
        description TEXT,
        specs_json TEXT,
        is_flash_sale INTEGER DEFAULT 0,
        flash_discount_percent INTEGER DEFAULT 0,
        is_mall INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vouchers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        discount_type TEXT NOT NULL, -- 'percent' or 'flat'
        discount_value REAL NOT NULL,
        min_spend INTEGER NOT NULL DEFAULT 0,
        expiry_text TEXT,
        claimed_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT UNIQUE NOT NULL,
        tracking_number TEXT UNIQUE NOT NULL,
        user_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        shipping_address TEXT NOT NULL,
        city TEXT NOT NULL,
        province TEXT NOT NULL,
        postal_code TEXT,
        payment_method TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        shipping_fee INTEGER NOT NULL DEFAULT 0,
        total_amount INTEGER NOT NULL,
        order_status TEXT DEFAULT 'Processing',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        product_image TEXT NOT NULL,
        unit_price INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        line_total INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        user_city TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL,
        subject TEXT,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'New',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// --- 2. PAKISTANI PAYMENT GATEWAY INTEGRATION ARCHITECTURE ---
const PAYMENT_GATEWAYS = {
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
        description: 'Meezan Bank Raast transfer with manual verification on WhatsApp (+92 300 1234567).',
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

// --- 2. AUTHENTICATION & SECURITY UTILITIES ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [salt, key] = storedHash.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return key === hash;
}

const activeTokens = new Map(); // token -> user object

function generateToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const userData = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        city: user.city,
        address: user.address
    };
    activeTokens.set(token, userData);
    return token;
}

function getAuthUser(req) {
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.headers['x-auth-token']) {
        token = req.headers['x-auth-token'];
    }
    return activeTokens.get(token) || null;
}

// In-Memory Sliding Window Rate Limiter
const rateLimitMap = new Map();
function checkRateLimit(ip, endpointKey, maxRequests, windowMs) {
    const now = Date.now();
    const key = `${ip}:${endpointKey}`;
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

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || '127.0.0.1';
}

// --- 3. SEED INITIAL DATA (IF EMPTY) ---
function seedDatabase() {
    const countCheck = db.prepare('SELECT COUNT(*) as count FROM products').get();
    if (countCheck.count === 0) {
        console.log('Seeding initial FitGear Pakistan database...');

        // Seed Users
        const insertUser = db.prepare('INSERT INTO users (name, email, phone, password_hash, role, city) VALUES (?, ?, ?, ?, ?, ?)');
        insertUser.run('Admin FitGear', 'admin@fitgear.pk', '03001234567', hashPassword('admin123'), 'admin', 'Lahore');
        insertUser.run('Demo Customer', 'customer@fitgear.pk', '03217654321', hashPassword('customer123'), 'customer', 'Karachi');

        // Seed Categories
        const insertCat = db.prepare('INSERT INTO categories (slug, name, icon, image, description) VALUES (?, ?, ?, ?, ?)');
        insertCat.run('cardio', 'Cardio Equipment', 'fa-running', 'images/treadmill.jpg', 'Treadmills, Air Bikes & Rowing Machines');
        insertCat.run('strength', 'Strength Training', 'fa-layer-group', 'images/workout_bench.jpg', 'Commercial Benches, Squat Cages & Power Racks');
        insertCat.run('weights', 'Free Weights', 'fa-dumbbell', 'images/dumbbell_set.jpg', 'Adjustable Dumbbells, Olympic Barbells & Kettlebells');
        insertCat.run('yoga', 'Yoga and Recovery', 'fa-spa', 'images/yoga_mat.jpg', 'High-Density Yoga Mats & Core Rollers');
        insertCat.run('accessories', 'Accessories', 'fa-mitten', 'images/resistance_bands.jpg', 'Weightlifting Belts, Gloves & Resistance Bands');

        // Seed Vouchers (Daraz-style collectible vouchers)
        const insertVoucher = db.prepare('INSERT INTO vouchers (code, title, discount_type, discount_value, min_spend, expiry_text) VALUES (?, ?, ?, ?, ?, ?)');
        insertVoucher.run('FITGEAR10', '10% OFF Sitewide', 'percent', 0.10, 3000, 'Valid until end of month');
        insertVoucher.run('WELCOME500', 'PKR 500 Welcome Voucher', 'flat', 500, 4000, 'First time buyers special');
        insertVoucher.run('DARAZFIT', 'PKR 1,500 Heavy Hardware Discount', 'flat', 1500, 20000, 'Super Savings on Racks & Treadmills');
        insertVoucher.run('BEASTMODE', '15% Elite Athlete Voucher', 'percent', 0.15, 10000, 'Mega Flash Deal Discount');

        // Seed Products
        const initialProducts = [
            {
                name: 'Adjustable Dumbbell Set (2.5kg - 24kg)',
                category: 'weights',
                price: 18500,
                original_price: 24000,
                stock: 18,
                sold: 84,
                badge: 'Daraz Top Pick',
                image: 'images/dumbbell_set.jpg',
                is_flash: 1,
                flash_pct: 23,
                description: 'Rapid-dial selector dumbbell set replacing 15 pairs. Machined silicon-steel plates with locking safety tray.',
                specs: { 'Weight Range': '2.5kg to 24kg', 'Material': 'Alloy Silicon Steel', 'Warranty': '2 Years Official' }
            },
            {
                name: 'Heavy Duty Commercial Motorized Treadmill 4.0 HP',
                category: 'cardio',
                price: 115000,
                original_price: 135000,
                stock: 6,
                sold: 32,
                badge: 'Mall Official',
                image: 'images/treadmill.jpg',
                is_flash: 1,
                flash_pct: 15,
                description: 'Industrial 4.0 HP DC peak silent motor, 15 levels power auto-incline, 8-point knee-cushioning system.',
                specs: { 'Motor': '4.0 HP Peak DC', 'Speed': '0.8-18 km/h', 'Max Weight': '160 kg', 'Warranty': '2 Years Motor Warranty' }
            },
            {
                name: 'Olympic Barbell 20kg + 100kg Tri-Grip Plates Set',
                category: 'weights',
                price: 38000,
                original_price: 45000,
                stock: 12,
                sold: 46,
                badge: 'Hot Seller',
                image: 'images/barbell_set.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: '7.2 ft standard Olympic barbell with dual copper bushings and rubber-encased cast iron tri-grip plates.',
                specs: { 'Bar Length': '2.2m (7.2ft)', 'Plate Breakdown': '2x20kg, 2x15kg, 2x10kg, 2x5kg', 'Knurl': 'Dual Grip Ring' }
            },
            {
                name: 'Commercial Multi-Angle Adjustable Workout Bench',
                category: 'strength',
                price: 24500,
                original_price: 29000,
                stock: 15,
                sold: 68,
                badge: 'Super Deal',
                image: 'images/workout_bench.jpg',
                is_flash: 1,
                flash_pct: 16,
                description: '7-angle incline, flat, and decline positions. Heavy 70x50mm steel frame supporting up to 350kg.',
                specs: { 'Angles': '7 Backrest Angles', 'Max Load': '350 kg', 'Padding': 'Tear-Proof Leather', 'Wheels': 'Integrated Mobility' }
            },
            {
                name: 'Cast Iron Olympic Weight Bumper Plates (20kg Pair)',
                category: 'weights',
                price: 13500,
                original_price: 16000,
                stock: 24,
                sold: 92,
                badge: 'Best Value',
                image: 'images/weight_plates.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Standard 50.4mm Olympic hole diameter with tri-grip contoured handles and black baked enamel rust protection.',
                specs: { 'Pair Weight': '20kg x 2 (40kg)', 'Hole Size': '2-inch Olympic', 'Material': 'Solid Cast Iron' }
            },
            {
                name: 'Commercial Squat Power Rack & Pull-Up Station',
                category: 'strength',
                price: 68000,
                original_price: 78000,
                stock: 7,
                sold: 21,
                badge: 'Heavy Gauge',
                image: 'images/power_rack.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Industrial 2.5mm heavy steel uprights with safety spotter arms, J-hooks, and multi-grip pull-up crossbar.',
                specs: { 'Capacity': '450 kg', 'Steel Tubing': '60x60mm 11-Gauge', 'Dimensions': '130x120x215 cm' }
            },
            {
                name: 'HIIT Crossfit Fan Air Bike (Wind Resistance)',
                category: 'cardio',
                price: 72000,
                original_price: 85000,
                stock: 8,
                sold: 29,
                badge: 'Mall Official',
                image: 'images/air_bike.jpg',
                is_flash: 1,
                flash_pct: 15,
                description: 'Exponential wind resistance fan wheel for HIIT, CrossFit interval sprints, and cardio conditioning.',
                specs: { 'Resistance': 'Infinite Air Fan', 'Drive': 'Heavy Chain Link', 'User Weight': '150 kg' }
            },
            {
                name: 'Magnetic Water-Feel Folding Rowing Machine',
                category: 'cardio',
                price: 58000,
                original_price: 69000,
                stock: 9,
                sold: 19,
                badge: 'New Arrival',
                image: 'images/rowing_machine.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: '16-level silent magnetic resistance with aluminum slide rail and vertical space-saving upright storage.',
                specs: { 'Resistance': '16 Levels Magnetic', 'Max Weight': '140 kg', 'Storage': 'Folds Vertically' }
            },
            {
                name: 'Solid Cast Iron Kettlebell Set (16kg + 24kg)',
                category: 'weights',
                price: 14500,
                original_price: 17500,
                stock: 14,
                sold: 53,
                badge: 'Popular',
                image: 'images/kettlebell.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Single-piece gravity cast iron with powder-coated texture for non-slip chalk grip and flat bottom stability.',
                specs: { 'Weights': '16kg & 24kg', 'Finish': 'Matte Powder Coat', 'Base': 'Machined Flat' }
            },
            {
                name: 'Multi-Level Resistance Bands Set (5 Tubes + Straps)',
                category: 'accessories',
                price: 3400,
                original_price: 4500,
                stock: 45,
                sold: 178,
                badge: 'Daraz Top Pick',
                image: 'images/resistance_bands.jpg',
                is_flash: 1,
                flash_pct: 24,
                description: '100% natural Malaysian latex stackable up to 150 lbs with foam handles, door anchor, and travel pouch.',
                specs: { 'Levels': '10 to 150 lbs', 'Material': 'Natural Latex', 'Included': '5 Bands + Accessories' }
            },
            {
                name: 'Pro Breathable Gym Workout Gloves with Wrist Wrap',
                category: 'accessories',
                price: 2200,
                original_price: 2800,
                stock: 50,
                sold: 215,
                badge: 'Best Seller',
                image: 'images/gym_gloves.jpg',
                is_flash: 1,
                flash_pct: 21,
                description: 'Honeycomb anti-slip silicone palm padding with 18-inch elastic compression wrist support.',
                specs: { 'Sizes': 'M, L, XL', 'Wrist Wrap': '18-inch Elastic', 'Material': 'Breathable Microfiber' }
            },
            {
                name: '10mm Genuine Cowhide Leather Weightlifting Belt',
                category: 'accessories',
                price: 6500,
                original_price: 8500,
                stock: 22,
                sold: 110,
                badge: 'Powerlifting',
                image: 'images/weightlifting_belt.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Competition grade 10mm top-grain leather with steel double-prong buckle and non-slip suede inner lining.',
                specs: { 'Thickness': '10mm', 'Width': '4 inches', 'Buckle': 'Dual Steel Prong' }
            },
            {
                name: 'High-Density 10mm Anti-Tear Yoga & Exercise Mat',
                category: 'yoga',
                price: 3800,
                original_price: 4800,
                stock: 30,
                sold: 142,
                badge: 'Comfort',
                image: 'images/yoga_mat.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'High-density 10mm NBR non-slip foam mat for spine, hip, and knee protection during floor workouts.',
                specs: { 'Thickness': '10mm', 'Dimensions': '183x61 cm', 'Included': 'Carrying Strap' }
            },
            {
                name: 'High-Speed Ball Bearing Cable Jump Rope',
                category: 'accessories',
                price: 1800,
                original_price: 2400,
                stock: 40,
                sold: 165,
                badge: 'Speed Cardio',
                image: 'images/jump_rope.jpg',
                is_flash: 1,
                flash_pct: 25,
                description: '360° dual ball bearing swivel with adjustable 3m PVC steel cable and knurled anti-slip handles.',
                specs: { 'Cable': '3m Steel Wire', 'Bearing': '360 Dual Ball Bearing', 'Handle': 'Knurled Aluminum' }
            },
            {
                name: 'Stainless Steel Insulated Protein Shaker 750ml',
                category: 'accessories',
                price: 2600,
                original_price: 3200,
                stock: 35,
                sold: 88,
                badge: 'Fitness',
                image: 'images/shaker_bottle.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Kitchen-grade 304 stainless steel double-wall vacuum insulated shaker bottle. Leakproof twist cap.',
                specs: { 'Capacity': '750 ml', 'Steel': 'Grade 304', 'Insulation': '24 hr Cold' }
            },
            {
                name: 'Heavy-Duty Dual Wheel Ab Roller with Knee Pad',
                category: 'yoga',
                price: 2400,
                original_price: 3000,
                stock: 28,
                sold: 95,
                badge: 'Core Beast',
                image: 'images/ab_roller.jpg',
                is_flash: 0,
                flash_pct: 0,
                description: 'Dual wide rubber wheels for lateral stability with sweat-absorbing handles and high-density knee mat.',
                specs: { 'Wheels': 'Dual Rubber', 'Capacity': '200 kg', 'Included': 'Thick Knee Mat' }
            }
        ];

        const insertProduct = db.prepare(`
            INSERT INTO products (name, category_slug, price, original_price, stock_count, sold_count, badge, image, description, specs_json, is_flash_sale, flash_discount_percent, is_mall)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        initialProducts.forEach(p => {
            insertProduct.run(
                p.name,
                p.category,
                p.price,
                p.original_price,
                p.stock,
                p.sold,
                p.badge,
                p.image,
                p.description,
                JSON.stringify(p.specs),
                p.is_flash,
                p.flash_pct,
                1
            );
        });

        // Seed Verified Reviews
        const insertReview = db.prepare('INSERT INTO reviews (product_id, user_name, user_city, rating, comment) VALUES (?, ?, ?, ?, ?)');
        insertReview.run(1, 'Tariq Mehmood', 'Lahore', 5, 'Dial selector functions smoothly. Replaced my whole dumbbell rack in my apartment.');
        insertReview.run(2, 'Kamran Abbasi', 'Islamabad', 5, 'Heavy gauge motor is completely silent and handles 15 km/h intervals effortlessly.');
        insertReview.run(3, 'Rashid Ali', 'Karachi', 5, 'Barbell knurling is crisp without ripping calluses. Weight plates fit snugly.');
        insertReview.run(4, 'Shahbaz Khan', 'Faisalabad', 5, 'Bench has zero wobble even with 120kg barbell press. Thick durable padding.');
        insertReview.run(10, 'Zainab Fatima', 'Rawalpindi', 5, 'Resistance bands are very high quality. Door anchor holds firmly.');

        console.log('Database successfully seeded with Daraz-inspired products and categories!');
    }
}

seedDatabase();

// --- 4. HTTP REQUEST UTILITIES ---
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

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

// --- 5. STATIC ASSET DISPATCHER ---
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
                res.writeHead(404, { 'Content-Type': 'text/html' });
                fs.createReadStream(notFoundPage).pipe(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/html' });
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

// --- 6. API REQUEST ROUTER ---
const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
        });
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;
    const method = req.method;

    // --- API ROUTES ---
    if (pathname.startsWith('/api/')) {
        try {
            // 1. GET /api/categories
            if (pathname === '/api/categories' && method === 'GET') {
                const categories = db.prepare(`
                    SELECT c.*, COUNT(p.id) as product_count
                    FROM categories c
                    LEFT JOIN products p ON p.category_slug = c.slug
                    GROUP BY c.id
                `).all();
                return sendJson(res, 200, { success: true, categories });
            }

            // 2. GET /api/products
            if (pathname === '/api/products' && method === 'GET') {
                let sql = 'SELECT * FROM products WHERE 1=1';
                const params = [];

                if (query.category && query.category !== 'all') {
                    sql += ' AND category_slug = ?';
                    params.push(query.category);
                }

                if (query.flash_sale === '1' || query.flash_sale === 'true') {
                    sql += ' AND is_flash_sale = 1';
                }

                if (query.search) {
                    sql += ' AND (name LIKE ? OR description LIKE ?)';
                    params.push(`%${query.search}%`, `%${query.search}%`);
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
                return sendJson(res, 200, { success: true, count: products.length, products });
            }

            // 3. GET /api/products/:id
            if (pathname.match(/^\/api\/products\/\d+$/) && method === 'GET') {
                const id = pathname.split('/').pop();
                const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
                if (!product) {
                    return sendJson(res, 404, { success: false, error: 'Product not found' });
                }

                const reviews = db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(id);
                const avgRatingRow = db.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE product_id = ?').get(id);

                product.specs = product.specs_json ? JSON.parse(product.specs_json) : {};
                product.reviews = reviews;
                product.avg_rating = avgRatingRow.avg_rating ? Number(avgRatingRow.avg_rating.toFixed(1)) : 5.0;
                product.reviews_count = avgRatingRow.count || 0;

                return sendJson(res, 200, { success: true, product });
            }

            // 4. POST /api/products (Admin create)
            if (pathname === '/api/products' && method === 'POST') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const body = await parseJsonBody(req);
                if (!body.name || !body.price || !body.category_slug) {
                    return sendJson(res, 400, { success: false, error: 'Missing required product fields' });
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

                return sendJson(res, 201, { success: true, message: 'Product created successfully', productId: result.lastInsertRowid });
            }

            // 5. PUT /api/products/:id (Admin update)
            if (pathname.match(/^\/api\/products\/\d+$/) && method === 'PUT') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const id = pathname.split('/').pop();
                const body = await parseJsonBody(req);

                db.prepare(`
                    UPDATE products
                    SET name = ?, category_slug = ?, price = ?, original_price = ?, stock_count = ?, badge = ?, description = ?, is_flash_sale = ?, flash_discount_percent = ?
                    WHERE id = ?
                `).run(
                    body.name,
                    body.category_slug,
                    Number(body.price),
                    Number(body.original_price),
                    Number(body.stock_count),
                    body.badge,
                    body.description,
                    body.is_flash_sale ? 1 : 0,
                    Number(body.flash_discount_percent || 0),
                    id
                );

                return sendJson(res, 200, { success: true, message: 'Product updated successfully' });
            }

            // 6. DELETE /api/products/:id (Admin delete)
            if (pathname.match(/^\/api\/products\/\d+$/) && method === 'DELETE') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const id = pathname.split('/').pop();
                db.prepare('DELETE FROM products WHERE id = ?').run(id);
                return sendJson(res, 200, { success: true, message: 'Product deleted' });
            }

            // 7. GET /api/vouchers
            if (pathname === '/api/vouchers' && method === 'GET') {
                const vouchers = db.prepare('SELECT * FROM vouchers ORDER BY min_spend ASC').all();
                return sendJson(res, 200, { success: true, vouchers });
            }

            // 8. POST /api/vouchers/validate
            if (pathname === '/api/vouchers/validate' && method === 'POST') {
                const body = await parseJsonBody(req);
                const code = (body.code || '').trim().toUpperCase();
                const subtotal = Number(body.subtotal) || 0;

                const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
                if (!voucher) {
                    return sendJson(res, 400, { success: false, error: 'Invalid voucher code' });
                }

                if (subtotal < voucher.min_spend) {
                    return sendJson(res, 400, {
                        success: false,
                        error: `Voucher requires a minimum spend of PKR ${voucher.min_spend.toLocaleString('en-PK')}`
                    });
                }

                const discountAmount = voucher.discount_type === 'percent'
                    ? Math.round(subtotal * voucher.discount_value)
                    : voucher.discount_value;

                return sendJson(res, 200, {
                    success: true,
                    voucher: {
                        code: voucher.code,
                        title: voucher.title,
                        discount_type: voucher.discount_type,
                        discount_value: voucher.discount_value,
                        discount_amount: discountAmount
                    }
                });
            }

            // 9. POST /api/auth/register
            if (pathname === '/api/auth/register' && method === 'POST') {
                const body = await parseJsonBody(req);
                const name = (body.name || '').trim();
                const email = (body.email || '').trim().toLowerCase();
                const phone = (body.phone || '').trim();
                const password = body.password || '';

                if (!name || !email || !password || password.length < 6) {
                    return sendJson(res, 400, { success: false, error: 'Please provide valid name, email, and password (min 6 characters)' });
                }

                const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
                if (existing) {
                    return sendJson(res, 409, { success: false, error: 'An account with this email already exists' });
                }

                const result = db.prepare(`
                    INSERT INTO users (name, email, phone, password_hash, role, city, address)
                    VALUES (?, ?, ?, ?, 'customer', ?, ?)
                `).run(name, email, phone, hashPassword(password), body.city || 'Lahore', body.address || '');

                const newUser = { id: result.lastInsertRowid, name, email, phone, role: 'customer' };
                const token = generateToken(newUser);

                return sendJson(res, 201, { success: true, token, user: newUser });
            }

            // 10. POST /api/auth/login
            if (pathname === '/api/auth/login' && method === 'POST') {
                const clientIp = getClientIp(req);
                if (!checkRateLimit(clientIp, 'auth_login', 15, 60000)) {
                    return sendJson(res, 429, { success: false, error: 'Too many login attempts. Please wait 1 minute before trying again.' });
                }

                const body = await parseJsonBody(req);
                const email = (body.email || '').trim().toLowerCase();
                const password = body.password || '';

                const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
                if (!user || !verifyPassword(password, user.password_hash)) {
                    return sendJson(res, 401, { success: false, error: 'Invalid email or password' });
                }

                const token = generateToken(user);
                return sendJson(res, 200, {
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
                });
            }

            // 11. GET /api/auth/me
            if (pathname === '/api/auth/me' && method === 'GET') {
                const user = getAuthUser(req);
                if (!user) {
                    return sendJson(res, 401, { success: false, error: 'Not authenticated' });
                }
                return sendJson(res, 200, { success: true, user });
            }

            // 11b. PATCH /api/auth/profile (Update Customer Profile in SQLite)
            if (pathname === '/api/auth/profile' && method === 'PATCH') {
                const user = getAuthUser(req);
                if (!user) {
                    return sendJson(res, 401, { success: false, error: 'Authentication required' });
                }

                const body = await parseJsonBody(req);
                const name = (body.name || user.name).trim();
                const phone = (body.phone || user.phone).trim();
                const city = (body.city || user.city || 'Lahore').trim();
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

                return sendJson(res, 200, { success: true, message: 'Profile updated in database successfully', user });
            }

            // 12. POST /api/orders (Create Real Database Order)
            if (pathname === '/api/orders' && method === 'POST') {
                const clientIp = getClientIp(req);
                if (!checkRateLimit(clientIp, 'orders', 30, 60000)) {
                    return sendJson(res, 429, { success: false, error: 'Too many order attempts. Please slow down.' });
                }

                const body = await parseJsonBody(req);
                const items = body.items || [];

                if (items.length === 0) {
                    return sendJson(res, 400, { success: false, error: 'Your cart is empty' });
                }

                const user = getAuthUser(req);
                const customerName = (body.customer_name || (user ? user.name : '')).trim();
                const customerPhone = (body.customer_phone || (user ? user.phone : '')).trim();
                const customerEmail = (body.customer_email || (user ? user.email : '')).trim();
                const address = (body.shipping_address || body.address || '').trim();
                const city = (body.city || 'Lahore').trim();
                const province = (body.province || 'Punjab').trim();
                const postalCode = body.postal_code || '';
                const paymentMethod = (body.payment_method || 'COD').toUpperCase();

                if (!customerName || !customerPhone || !address) {
                    return sendJson(res, 400, { success: false, error: 'Please provide full name, phone, and delivery address' });
                }

                // Begin Immediate SQLite Transaction for strict inventory concurrency protection
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

                    // Shipping fee calculation: Free over PKR 5,000, else PKR 500
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

                    // Insert Order Record
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

                    // Insert Order Items & Deduct Stock Atomically
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

                    // Commit Transaction
                    db.exec('COMMIT');

                    return sendJson(res, 201, {
                        success: true,
                        order_id: orderId,
                        order_number: orderNumber,
                        tracking_number: trackingNumber,
                        customer_name: customerName,
                        total_amount: totalAmount,
                        order_status: 'Processing',
                        message: 'Order created and persisted in database successfully!'
                    });
                } catch (orderErr) {
                    db.exec('ROLLBACK');
                    return sendJson(res, 400, { success: false, error: orderErr.message });
                }
            }

            // 13. GET /api/orders (Listing for current user or admin)
            if (pathname === '/api/orders' && method === 'GET') {
                const user = getAuthUser(req);
                let orders = [];

                if (user && user.role === 'admin') {
                    orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
                } else if (user) {
                    orders = db.prepare('SELECT * FROM orders WHERE user_id = ? OR customer_email = ? ORDER BY id DESC').all(user.id, user.email);
                } else {
                    return sendJson(res, 401, { success: false, error: 'Authentication required to view order history' });
                }

                // Attach items
                const getItemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
                orders.forEach(o => {
                    o.items = getItemStmt.all(o.id);
                });

                return sendJson(res, 200, { success: true, count: orders.length, orders });
            }

            // 14. GET /api/orders/track/:query (Live Track by order_number, tracking_number, or phone)
            if (pathname.startsWith('/api/orders/track/') && method === 'GET') {
                const searchVal = decodeURIComponent(pathname.replace('/api/orders/track/', '')).trim();
                const order = db.prepare(`
                    SELECT * FROM orders
                    WHERE order_number = ? OR tracking_number = ? OR customer_phone = ?
                    ORDER BY id DESC LIMIT 1
                `).get(searchVal, searchVal, searchVal);

                if (!order) {
                    return sendJson(res, 404, { success: false, error: `No active order found for query "${searchVal}"` });
                }

                order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
                return sendJson(res, 200, { success: true, order });
            }

            // 15. PATCH /api/orders/:id/status (Admin status update with safe inventory restoration)
            if (pathname.match(/^\/api\/orders\/\d+\/status$/) && method === 'PATCH') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const id = pathname.split('/')[3];
                const body = await parseJsonBody(req);
                const newStatus = (body.status || '').trim();

                const allowedStatuses = ['Pending', 'Processing', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
                if (!allowedStatuses.includes(newStatus)) {
                    return sendJson(res, 400, { success: false, error: `Invalid status "${newStatus}". Allowed: ${allowedStatuses.join(', ')}` });
                }

                db.exec('BEGIN IMMEDIATE');
                try {
                    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
                    if (!order) {
                        db.exec('ROLLBACK');
                        return sendJson(res, 404, { success: false, error: 'Order not found' });
                    }

                    const oldStatus = order.order_status;
                    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);

                    // CASE 1: Moving to 'Cancelled' -> Safely restore inventory to catalog
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

                    // CASE 2: Reactivating a 'Cancelled' order -> Validate stock and re-reserve
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

                    return sendJson(res, 200, {
                        success: true,
                        order_id: Number(id),
                        previous_status: oldStatus,
                        new_status: newStatus,
                        message: `Order #${id} status updated from ${oldStatus} to ${newStatus}`
                    });
                } catch (statusErr) {
                    db.exec('ROLLBACK');
                    return sendJson(res, 400, { success: false, error: statusErr.message });
                }
            }

            // 15b. GET /api/reviews (Recent verified reviews from database)
            if (pathname === '/api/reviews' && method === 'GET') {
                const reviews = db.prepare(`
                    SELECT r.*, p.name AS product_name
                    FROM reviews r
                    LEFT JOIN products p ON r.product_id = p.id
                    ORDER BY r.id DESC
                    LIMIT 8
                `).all();
                return sendJson(res, 200, { success: true, reviews });
            }

            // 16. POST /api/reviews
            if (pathname === '/api/reviews' && method === 'POST') {
                const body = await parseJsonBody(req);
                const productId = Number(body.product_id);
                const name = (body.user_name || '').trim();
                const city = (body.user_city || 'Pakistan').trim();
                const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));
                const comment = (body.comment || '').trim();

                if (!productId || !name || !comment) {
                    return sendJson(res, 400, { success: false, error: 'Please provide name, rating, and feedback comment' });
                }

                db.prepare(`
                    INSERT INTO reviews (product_id, user_name, user_city, rating, comment)
                    VALUES (?, ?, ?, ?, ?)
                `).run(productId, name, city, rating, comment);

                return sendJson(res, 201, { success: true, message: 'Review submitted and saved to database!' });
            }

            // 17. GET /api/admin/metrics (Admin Dashboard Analytics)
            if (pathname === '/api/admin/metrics' && method === 'GET') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const totalSales = db.prepare("SELECT SUM(total_amount) as total FROM orders WHERE order_status != 'Cancelled'").get();
                const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get();
                const totalCustomers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'customer'").get();
                const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products').get();
                const lowStockProducts = db.prepare('SELECT * FROM products WHERE stock_count <= 8 ORDER BY stock_count ASC').all();
                const recentOrders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();

                return sendJson(res, 200, {
                    success: true,
                    metrics: {
                        revenue: totalSales.total || 0,
                        orders_count: totalOrders.count || 0,
                        customers_count: totalCustomers.count || 0,
                        products_count: totalProducts.count || 0,
                        low_stock: lowStockProducts,
                        recent_orders: recentOrders
                    }
                });
            }

            // 17b. GET /api/admin/customers (Admin Registered Customer Directory)
            if (pathname === '/api/admin/customers' && method === 'GET') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
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

                return sendJson(res, 200, { success: true, count: customers.length, customers });
            }

            // 17c. GET /api/admin/system (Diagnostic & System Info)
            if (pathname === '/api/admin/system' && method === 'GET') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const dbStats = fs.statSync(DB_PATH);
                return sendJson(res, 200, {
                    success: true,
                    system: {
                        node_version: process.version,
                        platform: process.platform,
                        uptime_seconds: Math.round(process.uptime()),
                        db_size_kb: Math.round(dbStats.size / 1024),
                        db_path: DB_PATH,
                        gateways: PAYMENT_GATEWAYS
                    }
                });
            }

            // 18. POST /api/contact (Storefront Customer Inquiry Handler)
            if (pathname === '/api/contact' && method === 'POST') {
                const clientIp = getClientIp(req);
                if (!checkRateLimit(clientIp, 'contact', 10, 60000)) {
                    return sendJson(res, 429, { success: false, error: 'Too many contact inquiries submitted. Please wait a minute.' });
                }

                const body = await parseJsonBody(req);
                const name = (body.name || '').trim();
                const phone = (body.phone || '').trim();
                const email = (body.email || '').trim();
                const subject = (body.subject || 'General Inquiry').trim();
                const message = (body.message || '').trim();

                if (!name || !phone || !email || !message) {
                    return sendJson(res, 400, { success: false, error: 'Please provide name, phone, email, and inquiry message' });
                }

                const result = db.prepare(`
                    INSERT INTO inquiries (name, phone, email, subject, message, status)
                    VALUES (?, ?, ?, ?, ?, 'New')
                `).run(name, phone, email, subject, message);

                return sendJson(res, 201, {
                    success: true,
                    inquiry_id: result.lastInsertRowid,
                    message: `Inquiry #INQ-${result.lastInsertRowid} recorded in FitGear support database. Our Lahore team will contact you via WhatsApp/Phone within 24 hours.`,
                    email_forwarded: !!(process.env.SMTP_HOST && process.env.SMTP_USER)
                });
            }

            // 19. GET /api/admin/inquiries (Admin Staff Inbox)
            if (pathname === '/api/admin/inquiries' && method === 'GET') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const inquiries = db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 50').all();
                return sendJson(res, 200, { success: true, count: inquiries.length, inquiries });
            }

            // 20. PATCH /api/admin/inquiries/:id/status
            if (pathname.match(/^\/api\/admin\/inquiries\/\d+\/status$/) && method === 'PATCH') {
                const user = getAuthUser(req);
                if (!user || user.role !== 'admin') {
                    return sendJson(res, 403, { success: false, error: 'Admin authorization required' });
                }

                const id = pathname.split('/')[4];
                const body = await parseJsonBody(req);
                const newStatus = body.status || 'Resolved';

                db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(newStatus, id);
                return sendJson(res, 200, { success: true, message: `Inquiry #${id} marked as ${newStatus}` });
            }

            // 21. GET /api/payment/gateways (Payment Methods Architecture)
            if (pathname === '/api/payment/gateways' && method === 'GET') {
                return sendJson(res, 200, {
                    success: true,
                    gateways: Object.values(PAYMENT_GATEWAYS),
                    active_methods: ['cod', 'bank_transfer'],
                    notice: 'Cash on Delivery and Bank Transfer are operational. JazzCash and EasyPaisa require merchant credentials in .env.'
                });
            }

            // 22. POST /api/payment/initiate (Gateway Transaction Dispatcher)
            if (pathname === '/api/payment/initiate' && method === 'POST') {
                const body = await parseJsonBody(req);
                const gatewayId = (body.gateway || 'cod').toLowerCase();
                const orderId = body.order_id;

                const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
                if (!order) {
                    return sendJson(res, 404, { success: false, error: 'Order not found for payment initialization' });
                }

                const gw = PAYMENT_GATEWAYS[gatewayId];
                if (!gw) {
                    return sendJson(res, 400, { success: false, error: 'Unsupported payment method requested' });
                }

                if (gatewayId === 'cod' || gatewayId === 'bank_transfer') {
                    return sendJson(res, 200, {
                        success: true,
                        gateway: gatewayId,
                        status: 'confirmed',
                        order_number: order.order_number,
                        instructions: gatewayId === 'cod' 
                            ? 'Keep exact cash ready for rider.' 
                            : 'Transfer amount via Raast to Meezan Bank PK36MEZN0002840105829182 and share receipt on WhatsApp.'
                    });
                }

                // Check credentials for online gateways
                if (!gw.is_configured) {
                    return sendJson(res, 400, {
                        success: false,
                        gateway: gatewayId,
                        error: `Payment gateway ${gw.name} is currently unconfigured. Real merchant credentials (${gw.required_env.join(', ')}) must be configured in .env before initiating live charges. Please select Cash on Delivery or Bank Transfer.`,
                        is_configured: false
                    });
                }

                // If configured, build signed gateway payload
                const txnRef = `TXN-${order.order_number}-${Date.now()}`;
                let payload = {};

                if (gatewayId === 'jazzcash') {
                    payload = {
                        pp_Version: '1.1',
                        pp_TxnType: 'MWALLET',
                        pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
                        pp_Password: process.env.JAZZCASH_PASSWORD,
                        pp_TxnRefNo: txnRef,
                        pp_Amount: order.total_amount * 100, // paisas
                        pp_TxnCurrency: 'PKR',
                        pp_ReturnURL: process.env.JAZZCASH_RETURN_URL,
                        pp_BillReference: order.order_number,
                        pp_Description: `FitGear Order ${order.order_number}`
                    };
                    // Generate HMAC-SHA256 integrity signature
                    const sortedFields = Object.keys(payload).sort().map(k => payload[k]).join('&');
                    payload.pp_SecureHash = crypto.createHmac('sha256', process.env.JAZZCASH_INTEGRITY_SALT || '').update(sortedFields).digest('hex').toUpperCase();
                }

                return sendJson(res, 200, {
                    success: true,
                    gateway: gatewayId,
                    endpoint: gw.endpoint,
                    payload,
                    txn_ref: txnRef
                });
            }

            // 23. POST /api/payment/callback/:gateway (IPN Webhook Listener)
            if (pathname.startsWith('/api/payment/callback/') && method === 'POST') {
                const gateway = pathname.split('/').pop().toLowerCase();
                const body = await parseJsonBody(req);
                console.log(`Received IPN webhook from ${gateway}:`, body);

                // Update order status if payment is verified
                if (body.pp_ResponseCode === '000' && body.pp_BillReference) {
                    db.prepare('UPDATE orders SET order_status = "Processing", notes = notes || " [Paid via JazzCash]" WHERE order_number = ?').run(body.pp_BillReference);
                }

                return sendJson(res, 200, { success: true, message: 'Webhook received' });
            }

            // Route Not Found in API
            return sendJson(res, 404, { success: false, error: 'API endpoint not found' });

        } catch (apiError) {
            console.error('API Error:', apiError);
            return sendJson(res, 500, { success: false, error: apiError.message || 'Server error' });
        }
    }

    // Default to serving static files
    serveStaticFile(req, res, pathname);
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 FitGear Pakistan (Daraz Edition) Server is Live!`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`💾 SQLite Database: ${DB_PATH}`);
    console.log(`👤 Admin Account: admin@fitgear.pk / admin123`);
    console.log(`🛒 Customer Account: customer@fitgear.pk / customer123`);
    console.log(`======================================================\n`);
});
