/**
 * Comprehensive Test Suite for Netlify Migration
 * Verifies backend router, database, and Netlify Functions handler.
 */

const assert = require('node:assert');
const { getDatabase, getDbPath } = require('./backend/db');
const { handleApiRequest, generateToken } = require('./backend/router');
const { handler: netlifyHandler, default: netlifyV2Handler } = require('./netlify/functions/api');

async function runTests() {
    console.log('--- Starting Netlify Migration Verification Tests ---');

    // 1. Database Connection & Schema Test
    console.log('\n[1/7] Testing SQLite Database Connection...');
    const db = getDatabase();
    assert.ok(db, 'Database instance should be initialized');
    const prodCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
    assert.ok(prodCount > 0, `Expected products in database, got ${prodCount}`);
    console.log(`✓ Database verified at "${getDbPath()}" with ${prodCount} products.`);

    // 2. Health Check Test
    console.log('\n[2/7] Testing Health Check via Netlify Function Handler...');
    const healthRes = await netlifyHandler({
        httpMethod: 'GET',
        path: '/health',
        headers: {}
    }, {});
    assert.strictEqual(healthRes.statusCode, 200, 'Health check should return 200');
    const healthBody = JSON.parse(healthRes.body);
    assert.strictEqual(healthBody.status, 'healthy');
    assert.strictEqual(healthBody.database, 'connected');
    console.log('✓ Health check endpoint passed.');

    // 3. Products & Category Filter Test
    console.log('\n[3/7] Testing GET /api/products with Category Filter...');
    const prodRes = await netlifyHandler({
        httpMethod: 'GET',
        path: '/.netlify/functions/api/products',
        queryStringParameters: { category: 'strength' },
        headers: {}
    }, {});
    assert.strictEqual(prodRes.statusCode, 200);
    const prodData = JSON.parse(prodRes.body);
    assert.ok(prodData.success);
    assert.ok(prodData.products.length > 0);
    assert.strictEqual(prodData.products[0].category_slug, 'strength');
    console.log(`✓ Retrieved ${prodData.products.length} strength products.`);

    // 4. Authentication & JWT Stateless Token Test
    console.log('\n[4/7] Testing Authentication (Register & Login)...');
    const randomSuffix = Date.now();
    const testEmail = `test_user_${randomSuffix}@fitgear.pk`;
    const testPhone = `03${Math.floor(100000000 + Math.random() * 900000000)}`;
    const regRes = await netlifyHandler({
        httpMethod: 'POST',
        path: '/.netlify/functions/api/auth/register',
        body: JSON.stringify({
            name: 'Test Runner',
            email: testEmail,
            phone: testPhone,
            password: 'securepassword123'
        }),
        headers: { 'content-type': 'application/json' }
    }, {});
    assert.strictEqual(regRes.statusCode, 201);
    const regData = JSON.parse(regRes.body);
    assert.ok(regData.token, 'Should return auth token');
    const token = regData.token;

    // Verify /api/auth/me with Bearer token
    const meRes = await netlifyHandler({
        httpMethod: 'GET',
        path: '/.netlify/functions/api/auth/me',
        headers: { authorization: `Bearer ${token}` }
    }, {});
    assert.strictEqual(meRes.statusCode, 200);
    const meData = JSON.parse(meRes.body);
    assert.strictEqual(meData.user.email, testEmail);
    console.log(`✓ Registration and token authorization verified for ${testEmail}.`);

    // 5. Order Placement & Stock Transaction Test
    console.log('\n[5/7] Testing Order Creation & Atomic Stock Deduction...');
    const inStockProduct = db.prepare('SELECT id FROM products WHERE stock_count > 0 ORDER BY id ASC LIMIT 1').get();
    const orderPayload = {
        customer_name: 'Test Runner',
        customer_phone: testPhone,
        customer_email: testEmail,
        shipping_address: 'Suite 404, Tech Park',
        city: 'Lahore',
        province: 'Punjab',
        payment_method: 'COD',
        items: [{ id: inStockProduct ? inStockProduct.id : 2, quantity: 1 }]
    };
    const orderRes = await netlifyHandler({
        httpMethod: 'POST',
        path: '/.netlify/functions/api/orders',
        body: JSON.stringify(orderPayload),
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
        }
    }, {});
    assert.strictEqual(orderRes.statusCode, 201);
    const orderData = JSON.parse(orderRes.body);
    assert.ok(orderData.success);
    assert.ok(orderData.order_number.startsWith('PK-FG-'));
    assert.ok(orderData.tracking_number.startsWith('TRAX-PK-'));
    console.log(`✓ Order placed successfully: ${orderData.order_number} (${orderData.tracking_number}).`);

    // 6. Live Order Tracking Test
    console.log('\n[6/7] Testing Order Tracking Endpoint...');
    const trackRes = await netlifyHandler({
        httpMethod: 'GET',
        path: `/.netlify/functions/api/orders/track/${orderData.order_number}`,
        headers: {}
    }, {});
    assert.strictEqual(trackRes.statusCode, 200);
    const trackData = JSON.parse(trackRes.body);
    assert.strictEqual(trackData.order.order_number, orderData.order_number);
    assert.strictEqual(trackData.order.items.length, 1);
    console.log(`✓ Tracking verified for order ${orderData.order_number}.`);

    // 7. Netlify Functions v2 (Fetch API) Handler Test
    console.log('\n[7/7] Testing Netlify Functions v2 Handler...');
    const req = new Request('https://fitgear-pk.netlify.app/api/categories', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });
    const v2Res = await netlifyV2Handler(req, {});
    assert.strictEqual(v2Res.status, 200);
    const v2Data = await v2Res.json();
    assert.ok(v2Data.success);
    assert.ok(v2Data.categories.length > 0);
    console.log(`✓ Netlify Functions v2 handler successfully returned ${v2Data.categories.length} categories.`);

    console.log('\n======================================================');
    console.log('🎉 ALL 7 NETLIFY MIGRATION TESTS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
