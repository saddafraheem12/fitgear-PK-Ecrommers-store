/**
 * FITGEAR PAKISTAN - DATABASE MANAGEMENT MODULE
 * Dual-Driver Database Architecture:
 * - Local Development: Node.js native SQLite (node:sqlite DatabaseSync)
 * - Cloud Serverless: Turso LibSQL client (@libsql/client) over HTTP/WebSockets
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@libsql/client');

let dbInstance = null;
let tursoClientInstance = null;
let currentDbPath = null;

/**
 * Detect which database driver should be active based on environment variables.
 * If TURSO_DATABASE_URL is set to a remote URL, activates the Turso LibSQL client.
 * Otherwise, falls back to local SQLite DatabaseSync.
 */
function getDriverType() {
    const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
    if (url && (url.startsWith('libsql://') || url.startsWith('https://') || url.startsWith('http://'))) {
        return 'turso';
    }
    return 'sqlite';
}

/**
 * Returns the remote Turso LibSQL client instance.
 */
function getTursoClient() {
    if (tursoClientInstance) return tursoClientInstance;

    const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
        throw new Error('TURSO_DATABASE_URL environment variable is not configured.');
    }

    tursoClientInstance = createClient({ url, authToken });
    return tursoClientInstance;
}

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

    // If target database already exists in /tmp (e.g. warm container), reuse it
    if (fs.existsSync(targetPath)) return;

    // Search for bundled fitgear.sqlite
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
        return; // Already populated
    }

    console.log('[Database] Seeding initial FitGear Pakistan data...');

    // Seed Users
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@fitgear.pk';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_NAME || 'Admin FitGear';
    const insertUser = db.prepare('INSERT INTO users (name, email, phone, password_hash, role, city) VALUES (?, ?, ?, ?, ?, ?)');
    insertUser.run(adminName, adminEmail, '03000000000', hashPassword(adminPassword), 'admin', 'Karachi');
    insertUser.run('Demo Customer', 'customer@fitgear.pk', '03217654321', hashPassword('customer123'), 'customer', 'Karachi');

    // Seed Categories
    const insertCat = db.prepare('INSERT INTO categories (slug, name, icon, image, description) VALUES (?, ?, ?, ?, ?)');
    insertCat.run('cardio', 'Cardio Equipment', 'fa-running', 'images/treadmill.jpg', 'Treadmills, Air Bikes & Rowing Machines');
    insertCat.run('strength', 'Strength Training', 'fa-layer-group', 'images/workout_bench.jpg', 'Commercial Benches, Squat Cages & Power Racks');
    insertCat.run('weights', 'Free Weights', 'fa-dumbbell', 'images/dumbbell_set.jpg', 'Adjustable Dumbbells, Olympic Barbells & Kettlebells');
    insertCat.run('yoga', 'Yoga and Recovery', 'fa-spa', 'images/yoga_mat.jpg', 'High-Density Yoga Mats & Core Rollers');
    insertCat.run('accessories', 'Accessories', 'fa-mitten', 'images/resistance_bands.jpg', 'Weightlifting Belts, Gloves & Resistance Bands');

    // Seed Vouchers
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

    console.log('[Database] Database successfully initialized and seeded!');
}

function getDatabase() {
    if (dbInstance) return dbInstance;

    const targetDbPath = resolveDbPath();
    currentDbPath = targetDbPath;

    // In serverless, ensure the writable directory exists and copy bundled db if first cold run
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
 * Diagnostic utility to test database connectivity for both drivers.
 */
async function testConnection() {
    const driver = getDriverType();
    const report = {
        activeDriver: driver,
        localSqlite: { status: 'unknown' },
        tursoCloud: { configured: false, status: 'unconfigured' }
    };

    // 1. Test Local SQLite
    try {
        const db = getDatabase();
        const testRow = db.prepare('SELECT 1 as connected').get();
        const prodCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
        const tableCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
        report.localSqlite = {
            status: testRow && testRow.connected === 1 ? 'operational' : 'error',
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

    // 2. Test Turso Cloud Client
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
        report.tursoCloud.message = 'TURSO_DATABASE_URL not set in environment. Local SQLite active.';
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
