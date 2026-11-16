/**
 * FITGEAR PAKISTAN - DATABASE MANAGEMENT MODULE
 * Multi-Tier Resilient Database Architecture:
 * 1. Local / Node 22: Native SQLite (node:sqlite DatabaseSync) with file persistence
 * 2. Cloud Serverless: Turso LibSQL client (@libsql/client) over HTTP/WebSockets
 * 3. Graceful Fallback: Built-in in-memory database store for serverless runtimes without node:sqlite
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Safely probe for Node 22 native SQLite
let DatabaseSync = null;
try {
    const sqliteModule = require('node:sqlite');
    if (sqliteModule && sqliteModule.DatabaseSync) {
        DatabaseSync = sqliteModule.DatabaseSync;
    }
} catch (e) {
    console.warn('[Database] node:sqlite DatabaseSync is not available in current Node runtime:', e.message);
}

// Safely probe for optional @libsql/client
let createClient = null;
try {
    const libsql = require('@libsql/client');
    if (libsql && libsql.createClient) {
        createClient = libsql.createClient;
    }
} catch (e) {
    // Optional @libsql/client
}

let dbInstance = null;
let tursoClientInstance = null;
let currentDbPath = null;
let isFallbackActive = false;

// -----------------------------------------------------------------------------
// INITIAL FITGEAR PAKISTAN STORE DATA
// -----------------------------------------------------------------------------

const INITIAL_CATEGORIES = [
    { slug: 'cardio', name: 'Cardio Equipment', icon: 'fa-running', image: 'images/treadmill.jpg', description: 'Treadmills, Air Bikes & Rowing Machines' },
    { slug: 'strength', name: 'Strength Training', icon: 'fa-layer-group', image: 'images/workout_bench.jpg', description: 'Commercial Benches, Squat Cages & Power Racks' },
    { slug: 'weights', name: 'Free Weights', icon: 'fa-dumbbell', image: 'images/dumbbell_set.jpg', description: 'Adjustable Dumbbells, Olympic Barbells & Kettlebells' },
    { slug: 'yoga', name: 'Yoga and Recovery', icon: 'fa-spa', image: 'images/yoga_mat.jpg', description: 'High-Density Yoga Mats & Core Rollers' },
    { slug: 'accessories', name: 'Accessories', icon: 'fa-mitten', image: 'images/resistance_bands.jpg', description: 'Weightlifting Belts, Gloves & Resistance Bands' }
];

const INITIAL_VOUCHERS = [
    { code: 'FITGEAR10', title: '10% OFF Sitewide', discount_type: 'percent', discount_value: 0.10, min_spend: 3000, expiry_text: 'Valid until end of month' },
    { code: 'WELCOME500', title: 'PKR 500 Welcome Voucher', discount_type: 'flat', discount_value: 500, min_spend: 4000, expiry_text: 'First time buyers special' },
    { code: 'DARAZFIT', title: 'PKR 1,500 Heavy Hardware Discount', discount_type: 'flat', discount_value: 1500, min_spend: 20000, expiry_text: 'Super Savings on Racks & Treadmills' },
    { code: 'BEASTMODE', title: '15% Elite Athlete Voucher', discount_type: 'percent', discount_value: 0.15, min_spend: 10000, expiry_text: 'Mega Flash Deal Discount' }
];

const INITIAL_PRODUCTS = [
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

const INITIAL_REVIEWS = [
    { product_id: 1, user_name: 'Tariq Mehmood', user_city: 'Lahore', rating: 5, comment: 'Dial selector functions smoothly. Replaced my whole dumbbell rack in my apartment.' },
    { product_id: 2, user_name: 'Kamran Abbasi', user_city: 'Islamabad', rating: 5, comment: 'Heavy gauge motor is completely silent and handles 15 km/h intervals effortlessly.' },
    { product_id: 3, user_name: 'Rashid Ali', user_city: 'Karachi', rating: 5, comment: 'Barbell knurling is crisp without ripping calluses. Weight plates fit snugly.' },
    { product_id: 4, user_name: 'Shahbaz Khan', user_city: 'Faisalabad', rating: 5, comment: 'Bench has zero wobble even with 120kg barbell press. Thick durable padding.' },
    { product_id: 10, user_name: 'Zainab Fatima', user_city: 'Rawalpindi', rating: 5, comment: 'Resistance bands are very high quality. Door anchor holds firmly.' }
];

// -----------------------------------------------------------------------------
// UTILITIES & AUTH
// -----------------------------------------------------------------------------

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.includes(':')) return false;
    const [salt, key] = storedHash.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return key === hash;
}

function isServerless() {
    return !!(
        process.env.NETLIFY ||
        process.env.AWS_LAMBDA_FUNCTION_NAME ||
        process.env.LAMBDA_TASK_ROOT ||
        process.env.VERCEL
    );
}

function resolveDbPath() {
    if (process.env.DB_PATH) {
        return path.isAbsolute(process.env.DB_PATH)
            ? process.env.DB_PATH
            : path.resolve(process.cwd(), process.env.DB_PATH);
    }

    if (isServerless()) {
        // AWS Lambda / Netlify Functions have read-only filesystems except for /tmp
        return path.join('/tmp', 'fitgear.sqlite');
    }

    // Local development: root of project
    return path.resolve(__dirname, '..', 'fitgear.sqlite');
}

function ensureServerlessDatabaseFile(targetPath) {
    if (!isServerless()) return;

    if (fs.existsSync(targetPath)) return;

    const candidatePaths = [
        path.resolve(__dirname, '..', 'fitgear.sqlite'),
        path.resolve(__dirname, 'fitgear.sqlite'),
        path.resolve(process.cwd(), 'fitgear.sqlite'),
        path.join(process.env.LAMBDA_TASK_ROOT || '', 'fitgear.sqlite')
    ];

    for (const src of candidatePaths) {
        if (src && fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, targetPath);
                console.log(`[Database] Copied bundled database from ${src} to ${targetPath}`);
                return;
            } catch (copyErr) {
                console.warn(`[Database] Failed to copy bundled DB from ${src}:`, copyErr.message);
            }
        }
    }
}

function getDriverType() {
    const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
    if (url && (url.startsWith('libsql://') || url.startsWith('https://') || url.startsWith('http://'))) {
        return 'turso';
    }
    return isFallbackActive ? 'in-memory' : 'sqlite';
}

function getTursoClient() {
    if (tursoClientInstance) return tursoClientInstance;

    const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
        throw new Error('TURSO_DATABASE_URL environment variable is not configured.');
    }

    if (!createClient) {
        throw new Error('@libsql/client package is not installed or available.');
    }

    tursoClientInstance = createClient({ url, authToken });
    return tursoClientInstance;
}

// -----------------------------------------------------------------------------
// NATIVE SQLITE SCHEMA & SEEDING (FOR Node 22 DatabaseSync)
// -----------------------------------------------------------------------------

function initSchema(db) {
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
            discount_type TEXT NOT NULL,
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
}

function seedDatabase(db) {
    const countCheck = db.prepare('SELECT COUNT(*) as count FROM products').get();
    if (countCheck && countCheck.count > 0) {
        return;
    }

    console.log('[Database] Seeding initial FitGear Pakistan data...');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@fitgear.pk';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_NAME || 'Admin FitGear';
    const insertUser = db.prepare('INSERT INTO users (name, email, phone, password_hash, role, city) VALUES (?, ?, ?, ?, ?, ?)');
    insertUser.run(adminName, adminEmail, '03000000000', hashPassword(adminPassword), 'admin', 'Karachi');
    insertUser.run('Demo Customer', 'customer@fitgear.pk', '03217654321', hashPassword('customer123'), 'customer', 'Karachi');

    const insertCat = db.prepare('INSERT INTO categories (slug, name, icon, image, description) VALUES (?, ?, ?, ?, ?)');
    INITIAL_CATEGORIES.forEach(c => insertCat.run(c.slug, c.name, c.icon, c.image, c.description));

    const insertVoucher = db.prepare('INSERT INTO vouchers (code, title, discount_type, discount_value, min_spend, expiry_text) VALUES (?, ?, ?, ?, ?, ?)');
    INITIAL_VOUCHERS.forEach(v => insertVoucher.run(v.code, v.title, v.discount_type, v.discount_value, v.min_spend, v.expiry_text));

    const insertProduct = db.prepare(`
        INSERT INTO products (name, category_slug, price, original_price, stock_count, sold_count, badge, image, description, specs_json, is_flash_sale, flash_discount_percent, is_mall)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    INITIAL_PRODUCTS.forEach(p => {
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

    const insertReview = db.prepare('INSERT INTO reviews (product_id, user_name, user_city, rating, comment) VALUES (?, ?, ?, ?, ?)');
    INITIAL_REVIEWS.forEach(r => insertReview.run(r.product_id, r.user_name, r.user_city, r.rating, r.comment));

    console.log('[Database] Database successfully initialized and seeded!');
}

// -----------------------------------------------------------------------------
// RESILIENT IN-MEMORY STORE FALLBACK (UNIVERSAL RUNTIME COMPATIBILITY)
// -----------------------------------------------------------------------------

function createFallbackDatabase() {
    isFallbackActive = true;
    console.log('[Database] In-memory fallback database active.');

    let nextUserId = 3;
    let nextProductId = INITIAL_PRODUCTS.length + 1;
    let nextOrderId = 1;
    let nextOrderItemId = 1;
    let nextReviewId = INITIAL_REVIEWS.length + 1;
    let nextInquiryId = 1;

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@fitgear.pk';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_NAME || 'Admin FitGear';

    const users = [
        {
            id: 1,
            name: adminName,
            email: adminEmail,
            phone: '03000000000',
            password_hash: hashPassword(adminPassword),
            role: 'admin',
            city: 'Karachi',
            address: 'FitGear HQ, Shahrah-e-Faisal, Karachi',
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            name: 'Demo Customer',
            email: 'customer@fitgear.pk',
            phone: '03217654321',
            password_hash: hashPassword('customer123'),
            role: 'customer',
            city: 'Karachi',
            address: 'DHA Phase 6, Karachi',
            created_at: new Date().toISOString()
        }
    ];

    const categories = INITIAL_CATEGORIES.map((c, i) => ({ id: i + 1, ...c }));
    const vouchers = INITIAL_VOUCHERS.map((v, i) => ({ id: i + 1, claimed_count: 0, ...v }));
    const products = INITIAL_PRODUCTS.map((p, i) => ({
        id: i + 1,
        name: p.name,
        category_slug: p.category,
        price: p.price,
        original_price: p.original_price,
        stock_count: p.stock,
        sold_count: p.sold,
        badge: p.badge,
        image: p.image,
        description: p.description,
        specs_json: JSON.stringify(p.specs),
        is_flash_sale: p.is_flash,
        flash_discount_percent: p.flash_pct,
        is_mall: 1,
        created_at: new Date().toISOString()
    }));

    const reviews = INITIAL_REVIEWS.map((r, i) => ({ id: i + 1, ...r, created_at: new Date().toISOString() }));
    const orders = [];
    const orderItems = [];
    const inquiries = [];

    return {
        exec(sql) {
            // Schemas or PRAGMA statements are no-ops in memory
            return true;
        },

        prepare(rawSql) {
            const sql = rawSql.trim();
            const lower = sql.toLowerCase();

            return {
                get(...args) {
                    if (lower.startsWith('select 1')) {
                        return { 1: 1, connected: 1 };
                    }

                    if (lower.includes('count(*)') && lower.includes('from products')) {
                        return { count: products.length, c: products.length };
                    }

                    if (lower.includes('count(*)') && lower.includes('from orders')) {
                        return { count: orders.length };
                    }

                    if (lower.includes('from sqlite_master')) {
                        return { count: 8 };
                    }

                    if (lower.includes('avg(rating)') && lower.includes('from reviews')) {
                        const pid = Number(args[0]);
                        const revs = reviews.filter(r => r.product_id === pid);
                        const sum = revs.reduce((acc, r) => acc + (r.rating || 0), 0);
                        return {
                            avg_rating: revs.length ? sum / revs.length : 0,
                            count: revs.length
                        };
                    }

                    if (lower.includes('from categories') && lower.includes('where slug =')) {
                        const slug = String(args[0]);
                        return categories.find(c => c.slug === slug) || null;
                    }

                    if (lower.includes('from products')) {
                        if (lower.includes('where id =')) {
                            const id = Number(args[0]);
                            const p = products.find(x => x.id === id);
                            if (!p) return null;
                            if (lower.includes('select id, name, stock_count')) {
                                return { id: p.id, name: p.name, stock_count: p.stock_count };
                            }
                            return { ...p };
                        }
                        if (lower.includes('stock_count > 0') && lower.includes('limit 1')) {
                            const p = products.find(x => x.stock_count > 0);
                            return p ? { id: p.id, name: p.name, stock_count: p.stock_count } : null;
                        }
                    }

                    if (lower.includes('from vouchers') && lower.includes('where code =')) {
                        const code = String(args[0] || '').toUpperCase();
                        const v = vouchers.find(x => x.code.toUpperCase() === code);
                        return v ? { ...v } : null;
                    }

                    if (lower.includes('from users')) {
                        if (lower.includes('where email =')) {
                            const email = String(args[0] || '').toLowerCase();
                            const u = users.find(x => x.email.toLowerCase() === email);
                            if (!u) return null;
                            if (lower.includes('select id from users')) {
                                return { id: u.id };
                            }
                            return { ...u };
                        }
                        if (lower.includes('where id =')) {
                            const id = Number(args[0]);
                            const u = users.find(x => x.id === id);
                            return u ? { ...u } : null;
                        }
                    }

                    if (lower.includes('from orders')) {
                        if (lower.includes('customer_phone = ? and customer_email = ? and total_amount = ?')) {
                            const [phone, email, amount] = args;
                            const thirtySecAgo = Date.now() - 30000;
                            const dup = orders.find(o =>
                                o.customer_phone === phone &&
                                o.customer_email === email &&
                                o.total_amount === Number(amount) &&
                                new Date(o.created_at).getTime() >= thirtySecAgo
                            );
                            return dup ? { id: dup.id, order_number: dup.order_number } : null;
                        }
                        if (lower.includes('order_number = ? or tracking_number = ? or customer_phone = ?')) {
                            const s = String(args[0] || '').trim();
                            const o = orders.slice().reverse().find(x =>
                                x.order_number === s || x.tracking_number === s || x.customer_phone === s
                            );
                            return o ? { ...o } : null;
                        }
                        if (lower.includes('where order_number =')) {
                            const num = String(args[0]);
                            const o = orders.find(x => x.order_number === num);
                            return o ? { ...o } : null;
                        }
                        if (lower.includes('where id =')) {
                            const id = Number(args[0]);
                            const o = orders.find(x => x.id === id);
                            return o ? { ...o } : null;
                        }
                    }

                    return null;
                },

                all(...args) {
                    if (lower.includes('from categories')) {
                        return categories.map(c => ({
                            ...c,
                            product_count: products.filter(p => p.category_slug === c.slug).length
                        }));
                    }

                    if (lower.includes('from vouchers')) {
                        return vouchers.slice().sort((a, b) => a.min_spend - b.min_spend);
                    }

                    if (lower.includes('from products')) {
                        if (lower.includes('stock_count <= 8')) {
                            return products.filter(p => p.stock_count <= 8).sort((a, b) => a.stock_count - b.stock_count);
                        }

                        let res = products.slice();
                        let argIdx = 0;

                        if (lower.includes('category_slug = ?')) {
                            const cat = args[argIdx++];
                            if (cat && cat !== 'all') {
                                res = res.filter(p => p.category_slug === cat);
                            }
                        }

                        if (lower.includes('is_flash_sale = 1')) {
                            res = res.filter(p => p.is_flash_sale === 1);
                        }

                        if (lower.includes('name like ? or description like ?')) {
                            const term = String(args[argIdx++] || '').replace(/%/g, '').toLowerCase();
                            argIdx++; // description placeholder
                            if (term) {
                                res = res.filter(p =>
                                    (p.name && p.name.toLowerCase().includes(term)) ||
                                    (p.description && p.description.toLowerCase().includes(term))
                                );
                            }
                        }

                        if (lower.includes('price <= ?')) {
                            const maxP = Number(args[argIdx++]);
                            if (maxP) {
                                res = res.filter(p => p.price <= maxP);
                            }
                        }

                        if (lower.includes('order by price asc')) {
                            res.sort((a, b) => a.price - b.price);
                        } else if (lower.includes('order by price desc')) {
                            res.sort((a, b) => b.price - a.price);
                        } else if (lower.includes('order by name asc')) {
                            res.sort((a, b) => a.name.localeCompare(b.name));
                        } else if (lower.includes('order by name desc')) {
                            res.sort((a, b) => b.name.localeCompare(a.name));
                        } else if (lower.includes('order by sold_count desc')) {
                            res.sort((a, b) => b.sold_count - a.sold_count);
                        } else {
                            res.sort((a, b) => a.id - b.id);
                        }

                        return res;
                    }

                    if (lower.includes('from order_items') && lower.includes('where order_id =')) {
                        const oid = Number(args[0]);
                        return orderItems.filter(item => item.order_id === oid);
                    }

                    if (lower.includes('from reviews')) {
                        if (lower.includes('where product_id =')) {
                            const pid = Number(args[0]);
                            return reviews.filter(r => r.product_id === pid).reverse();
                        }
                        return reviews.slice().reverse();
                    }

                    if (lower.includes('from inquiries')) {
                        return inquiries.slice().reverse().slice(0, 50);
                    }

                    if (lower.includes('from users u') && lower.includes('left join orders o')) {
                        return users.map(u => {
                            const userOrders = orders.filter(o => o.user_id === u.id || o.customer_email === u.email);
                            const totalSpent = userOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
                            return {
                                id: u.id,
                                name: u.name,
                                email: u.email,
                                phone: u.phone,
                                city: u.city,
                                address: u.address,
                                role: u.role,
                                created_at: u.created_at,
                                orders_count: userOrders.length,
                                total_spent: totalSpent
                            };
                        }).reverse();
                    }

                    if (lower.includes('from orders')) {
                        if (lower.includes('where user_id = ? or customer_email = ?')) {
                            const [uid, email] = args;
                            return orders.filter(o => o.user_id === uid || o.customer_email === email).reverse();
                        }
                        if (lower.includes('limit 8')) {
                            return orders.slice().reverse().slice(0, 8);
                        }
                        return orders.slice().reverse();
                    }

                    return [];
                },

                run(...args) {
                    if (lower.startsWith('insert into products')) {
                        const [name, category_slug, price, original_price, stock_count, badge, image, description, specs_json, is_flash_sale, flash_discount_percent] = args;
                        const newId = nextProductId++;
                        products.push({
                            id: newId,
                            name,
                            category_slug,
                            price: Number(price),
                            original_price: Number(original_price || price),
                            stock_count: Number(stock_count || 10),
                            sold_count: 0,
                            badge: badge || 'New',
                            image: image || 'images/dumbbell_set.jpg',
                            description: description || '',
                            specs_json: typeof specs_json === 'string' ? specs_json : JSON.stringify(specs_json || {}),
                            is_flash_sale: is_flash_sale ? 1 : 0,
                            flash_discount_percent: Number(flash_discount_percent || 0),
                            is_mall: 1,
                            created_at: new Date().toISOString()
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('update products')) {
                        if (lower.includes('stock_count = stock_count - ?')) {
                            const [qtySub, qtySold, prodId, minStock] = args;
                            const p = products.find(x => x.id === Number(prodId));
                            if (p && p.stock_count >= Number(minStock)) {
                                p.stock_count -= Number(qtySub);
                                p.sold_count += Number(qtySold);
                                return { lastInsertRowid: 0, changes: 1 };
                            }
                            return { lastInsertRowid: 0, changes: 0 };
                        }
                        if (lower.includes('stock_count = stock_count + ?')) {
                            const [qtyAdd, qtySoldSub, prodId] = args;
                            const p = products.find(x => x.id === Number(prodId));
                            if (p) {
                                p.stock_count += Number(qtyAdd);
                                p.sold_count = Math.max(0, p.sold_count - Number(qtySoldSub));
                                return { lastInsertRowid: 0, changes: 1 };
                            }
                            return { lastInsertRowid: 0, changes: 0 };
                        }
                        const id = Number(args[args.length - 1]);
                        const p = products.find(x => x.id === id);
                        if (p) {
                            const [name, category_slug, price, original_price, stock_count, badge, description, is_flash_sale, flash_discount_percent] = args;
                            if (name !== undefined) p.name = name;
                            if (category_slug !== undefined) p.category_slug = category_slug;
                            if (price !== undefined) p.price = Number(price);
                            if (original_price !== undefined) p.original_price = Number(original_price);
                            if (stock_count !== undefined) p.stock_count = Number(stock_count);
                            if (badge !== undefined) p.badge = badge;
                            if (description !== undefined) p.description = description;
                            if (is_flash_sale !== undefined) p.is_flash_sale = is_flash_sale ? 1 : 0;
                            if (flash_discount_percent !== undefined) p.flash_discount_percent = Number(flash_discount_percent);
                            return { lastInsertRowid: 0, changes: 1 };
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    if (lower.startsWith('delete from products')) {
                        const id = Number(args[0]);
                        const idx = products.findIndex(p => p.id === id);
                        if (idx > -1) {
                            products.splice(idx, 1);
                            return { lastInsertRowid: 0, changes: 1 };
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    if (lower.startsWith('insert into users')) {
                        const [name, email, phone, password_hash, city, address] = args;
                        const newId = nextUserId++;
                        users.push({
                            id: newId,
                            name,
                            email,
                            phone,
                            password_hash,
                            role: 'customer',
                            city: city || 'Karachi',
                            address: address || '',
                            created_at: new Date().toISOString()
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('update users')) {
                        if (lower.includes('password_hash = ?')) {
                            const [newHash, id] = args;
                            const u = users.find(x => x.id === Number(id));
                            if (u) {
                                u.password_hash = newHash;
                                return { lastInsertRowid: 0, changes: 1 };
                            }
                        } else {
                            const [name, phone, city, address, id] = args;
                            const u = users.find(x => x.id === Number(id));
                            if (u) {
                                if (name !== undefined) u.name = name;
                                if (phone !== undefined) u.phone = phone;
                                if (city !== undefined) u.city = city;
                                if (address !== undefined) u.address = address;
                                return { lastInsertRowid: 0, changes: 1 };
                            }
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    if (lower.startsWith('insert into orders')) {
                        const [order_number, tracking_number, user_id, customer_name, customer_phone, customer_email, shipping_address, city, province, postal_code, payment_method, subtotal, discount_amount, shipping_fee, total_amount, notes] = args;
                        const newId = nextOrderId++;
                        orders.push({
                            id: newId,
                            order_number,
                            tracking_number,
                            user_id: user_id || null,
                            customer_name,
                            customer_phone,
                            customer_email,
                            shipping_address,
                            city,
                            province,
                            postal_code,
                            payment_method,
                            subtotal: Number(subtotal),
                            discount_amount: Number(discount_amount || 0),
                            shipping_fee: Number(shipping_fee || 0),
                            total_amount: Number(total_amount),
                            order_status: 'Processing',
                            notes: notes || '',
                            created_at: new Date().toISOString()
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('update orders set order_status = ?')) {
                        const [newStatus, id] = args;
                        const o = orders.find(x => x.id === Number(id));
                        if (o) {
                            o.order_status = newStatus;
                            return { lastInsertRowid: 0, changes: 1 };
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    if (lower.startsWith('insert into order_items')) {
                        const [order_id, product_id, product_name, product_image, unit_price, quantity, line_total] = args;
                        const newId = nextOrderItemId++;
                        orderItems.push({
                            id: newId,
                            order_id: Number(order_id),
                            product_id: Number(product_id),
                            product_name,
                            product_image,
                            unit_price: Number(unit_price),
                            quantity: Number(quantity),
                            line_total: Number(line_total)
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('insert into reviews')) {
                        const [product_id, user_name, user_city, rating, comment] = args;
                        const newId = nextReviewId++;
                        reviews.push({
                            id: newId,
                            product_id: Number(product_id),
                            user_name,
                            user_city,
                            rating: Number(rating),
                            comment,
                            created_at: new Date().toISOString()
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('update vouchers set claimed_count')) {
                        const vid = Number(args[0]);
                        const v = vouchers.find(x => x.id === vid);
                        if (v) {
                            v.claimed_count = (v.claimed_count || 0) + 1;
                            return { lastInsertRowid: 0, changes: 1 };
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    if (lower.startsWith('insert into inquiries')) {
                        const [name, phone, email, subject, message] = args;
                        const newId = nextInquiryId++;
                        inquiries.push({
                            id: newId,
                            name,
                            phone,
                            email,
                            subject: subject || 'General Inquiry',
                            message,
                            status: 'New',
                            created_at: new Date().toISOString()
                        });
                        return { lastInsertRowid: newId, changes: 1 };
                    }

                    if (lower.startsWith('update inquiries set status = ?')) {
                        const [newStatus, id] = args;
                        const inq = inquiries.find(x => x.id === Number(id));
                        if (inq) {
                            inq.status = newStatus;
                            return { lastInsertRowid: 0, changes: 1 };
                        }
                        return { lastInsertRowid: 0, changes: 0 };
                    }

                    return { lastInsertRowid: 0, changes: 1 };
                }
            };
        }
    };
}

// -----------------------------------------------------------------------------
// PRIMARY DATABASE FACTORY
// -----------------------------------------------------------------------------

function getDatabase() {
    if (dbInstance) return dbInstance;

    const targetDbPath = resolveDbPath();
    currentDbPath = targetDbPath;

    if (DatabaseSync) {
        try {
            const dbDir = path.dirname(targetDbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            ensureServerlessDatabaseFile(targetDbPath);

            dbInstance = new DatabaseSync(targetDbPath);

            try {
                dbInstance.exec('PRAGMA journal_mode = WAL;');
            } catch (e) {
                try { dbInstance.exec('PRAGMA journal_mode = DELETE;'); } catch (_) {}
            }

            try {
                dbInstance.exec('PRAGMA foreign_keys = ON;');
            } catch (_) {}

            initSchema(dbInstance);
            seedDatabase(dbInstance);

            return dbInstance;
        } catch (dbErr) {
            console.warn('[Database] Native SQLite initialization failed. Engaging in-memory database store:', dbErr.message);
        }
    } else {
        console.warn('[Database] node:sqlite DatabaseSync not present in this Node runtime. Engaging in-memory database store.');
    }

    dbInstance = createFallbackDatabase();
    return dbInstance;
}

function getDbPath() {
    return currentDbPath || resolveDbPath();
}

/**
 * Unified async query helper: fetch a single row.
 * Works seamlessly with both local SQLite and remote Turso LibSQL.
 */
async function queryOne(sql, args = []) {
    if (getDriverType() === 'turso') {
        const client = getTursoClient();
        const res = await client.execute({ sql, args });
        return res.rows.length > 0 ? res.rows[0] : null;
    } else {
        const db = getDatabase();
        return db.prepare(sql).get(...args) || null;
    }
}

/**
 * Unified async query helper: fetch all matching rows.
 * Works seamlessly with both local SQLite and remote Turso LibSQL.
 */
async function queryAll(sql, args = []) {
    if (getDriverType() === 'turso') {
        const client = getTursoClient();
        const res = await client.execute({ sql, args });
        return res.rows;
    } else {
        const db = getDatabase();
        return db.prepare(sql).all(...args);
    }
}

/**
 * Unified async query helper: execute an INSERT, UPDATE, or DELETE.
 * Works seamlessly with both local SQLite and remote Turso LibSQL.
 */
async function execute(sql, args = []) {
    if (getDriverType() === 'turso') {
        const client = getTursoClient();
        return await client.execute({ sql, args });
    } else {
        const db = getDatabase();
        return db.prepare(sql).run(...args);
    }
}

/**
 * Diagnostic utility to test database connectivity for all drivers.
 */
async function testConnection() {
    const driver = getDriverType();
    const report = {
        activeDriver: driver,
        localSqlite: { status: 'unknown' },
        tursoCloud: { configured: false, status: 'unconfigured' }
    };

    try {
        const db = getDatabase();
        const testRow = db.prepare('SELECT 1 as connected').get();
        const prodCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
        const tableCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
        report.localSqlite = {
            status: testRow && (testRow.connected === 1 || testRow['1'] === 1) ? 'operational' : 'error',
            driver: isFallbackActive ? 'in-memory-fallback' : 'native-node-sqlite',
            path: getDbPath(),
            tables: tableCount ? tableCount.count : 0,
            products: prodCount ? prodCount.count : 0
        };
    } catch (err) {
        report.localSqlite = {
            status: 'failed',
            error: err.message
        };
    }

    const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
    if (tursoUrl) {
        report.tursoCloud.configured = true;
        report.tursoCloud.url = tursoUrl.replace(/:[^:@]*@/, ':****@');
        try {
            const client = getTursoClient();
            const res = await client.execute('SELECT 1 as connected');
            report.tursoCloud.status = res.rows.length > 0 ? 'operational' : 'error';
        } catch (err) {
            report.tursoCloud.status = 'failed';
            report.tursoCloud.error = err.message;
        }
    } else {
        report.tursoCloud.configured = false;
        report.tursoCloud.status = 'unconfigured';
        report.tursoCloud.message = 'TURSO_DATABASE_URL not set in environment.';
    }

    return report;
}

module.exports = {
    getDatabase,
    getDbPath,
    getDriverType,
    getTursoClient,
    queryOne,
    queryAll,
    execute,
    testConnection,
    hashPassword,
    verifyPassword,
    seedDatabase,
    initSchema,
    isServerless
};
