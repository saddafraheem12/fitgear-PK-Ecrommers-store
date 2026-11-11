/**
 * FITGEAR PAKISTAN - REAL DATABASE-BACKED E-COMMERCE ENGINE
 * Inspired by Daraz Pakistan
 * Powered by Node.js, SQLite (node:sqlite), and Vanilla JavaScript
 */

// Dynamic API Base URL resolution via js/config.js or intelligent environment detection
const API_BASE = (window.FITGEAR_CONFIG && typeof window.FITGEAR_CONFIG.getApiUrl === 'function')
    ? window.FITGEAR_CONFIG.getApiUrl()
    : ((typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
        ? (window.location.port === '3000' ? '' : 'http://localhost:3000')
        : 'https://fitgear-pk.onrender.com');

// Global State
let products = [];
let categories = [];
let vouchers = [];
let cart = [];
let wishlist = [];
let currentUser = null;
let appliedVoucher = null;
let collectedVouchers = [];
let isOrderSubmitting = false;

const whatsappNumber = '923000000000';

// Safe HTML Escaping Utility
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatPKR(num) {
    return `PKR ${Math.round(num || 0).toLocaleString('en-PK')}`;
}

// Toast Alert System
function showToast(message, type = 'success') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : (type === 'info' ? 'fa-info-circle' : 'fa-bell');
    toast.innerHTML = `<i class="fas ${icon}"></i> <span>${escapeHTML(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

// --- 1. DATA API CLIENT (SQLITE BACKED) ---
async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('fitgearToken');
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const options = { method, headers };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, options);
        return await res.json();
    } catch (err) {
        console.warn(`API call failed for ${endpoint}:`, err.message);
        return { success: false, error: err.message };
    }
}

// Load initial data from database
async function loadInitialData() {
    loadLocalState();

    // 1. Check current logged-in user
    const token = localStorage.getItem('fitgearToken');
    if (token) {
        const userRes = await apiRequest('/api/auth/me');
        if (userRes.success && userRes.user) {
            currentUser = userRes.user;
        } else {
            localStorage.removeItem('fitgearToken');
            currentUser = null;
        }
    }
    updateAuthUI();

    // 2. Fetch products from SQLite
    const prodRes = await apiRequest('/api/products');
    if (prodRes.success && prodRes.products) {
        products = prodRes.products;
    }

    // 3. Fetch vouchers
    const voucherRes = await apiRequest('/api/vouchers');
    if (voucherRes.success && voucherRes.vouchers) {
        vouchers = voucherRes.vouchers;
    }

    updateHeaderBadges();
    updateWishlistIcons();
    renderMiniCart();

    // Trigger page-specific initializations
    const path = window.location.pathname;
    if (path.includes('shop.html')) {
        initShopPage();
    } else if (path.includes('cart.html')) {
        renderCartPage();
    } else if (path.includes('checkout.html')) {
        initCheckoutPage();
    } else if (path.includes('wishlist.html')) {
        renderWishlistPage();
    } else if (path.includes('track-order.html')) {
        initTrackOrderPage();
    } else if (path.includes('admin.html')) {
        initAdminPage();
    } else if (path.includes('product.html')) {
        initProductDetailPage();
    } else if (path.includes('account.html')) {
        initAccountPage();
    } else {
        initHomePage();
    }
}

function loadLocalState() {
    try {
        const storedCart = localStorage.getItem('fitgearCart');
        if (storedCart) cart = JSON.parse(storedCart);

        const storedWishlist = localStorage.getItem('fitgearWishlist');
        if (storedWishlist) wishlist = JSON.parse(storedWishlist);

        const storedVouchers = localStorage.getItem('fitgearCollectedVouchers');
        if (storedVouchers) collectedVouchers = JSON.parse(storedVouchers);

        const storedApplied = localStorage.getItem('fitgearAppliedVoucher');
        if (storedApplied) appliedVoucher = JSON.parse(storedApplied);
    } catch (e) {
        console.error('Storage parse error:', e);
    }
}

function saveCart() {
    localStorage.setItem('fitgearCart', JSON.stringify(cart));
    updateHeaderBadges();
    renderMiniCart();
}

function saveWishlist() {
    localStorage.setItem('fitgearWishlist', JSON.stringify(wishlist));
    updateHeaderBadges();
    updateWishlistIcons();
}

// --- 2. AUTHENTICATION & HEADER UI ---
function updateAuthUI() {
    const authContainer = document.getElementById('header-auth-section');
    if (!authContainer) return;

    if (currentUser) {
        authContainer.innerHTML = `
            <div class="auth-user-dropdown" onclick="toggleUserMenu()">
                <i class="fas fa-user-circle" style="font-size: 1.1rem; color: var(--accent);"></i>
                <span>${escapeHTML(currentUser.name.split(' ')[0])}</span>
                ${currentUser.role === 'admin' ? '<span class="auth-user-badge">ADMIN</span>' : ''}
                <i class="fas fa-chevron-down" style="font-size: 0.7rem;"></i>
                <div class="user-dropdown-menu" id="user-dropdown-menu" style="display: none; position: absolute; top: 100%; right: 0; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 10px; width: 170px; z-index: 1050; box-shadow: var(--shadow-lg);">
                    <div style="font-size: 0.78rem; color: var(--text-muted); padding-bottom: 6px; border-bottom: 1px solid var(--border-color);">
                        ${escapeHTML(currentUser.email)}
                    </div>
                    ${currentUser.role === 'admin' ? '<a href="admin.html" style="display: block; padding: 8px 0; color: var(--accent); font-weight: 700;"><i class="fas fa-tachometer-alt"></i> Admin Panel</a>' : ''}
                    <a href="account.html" style="display: block; padding: 8px 0; color: var(--text-primary);"><i class="fas fa-user-circle"></i> My Account</a>
                    <a href="account.html?tab=orders" style="display: block; padding: 8px 0; color: var(--text-primary);"><i class="fas fa-box"></i> My Orders</a>
                    <a href="track-order.html" style="display: block; padding: 8px 0; color: var(--text-primary);"><i class="fas fa-truck"></i> Track Waybill</a>
                    <a href="javascript:void(0)" onclick="handleLogout()" style="display: block; padding: 8px 0; color: #ef4444; border-top: 1px solid var(--border-color);"><i class="fas fa-sign-out-alt"></i> Logout</a>
                </div>
            </div>
        `;
    } else {
        authContainer.innerHTML = `
            <a href="javascript:void(0)" onclick="openAuthModal('login')" style="color: var(--text-secondary); font-weight: 700; font-size: 0.85rem;">
                <i class="fas fa-user"></i> Login / Register
            </a>
        `;
    }
}

function toggleUserMenu() {
    const menu = document.getElementById('user-dropdown-menu');
    if (menu) {
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.auth-user-dropdown')) {
        const menu = document.getElementById('user-dropdown-menu');
        if (menu) menu.style.display = 'none';
    }
});

function openAuthModal(tab = 'login') {
    let modal = document.getElementById('auth-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'auth-modal';
        modal.innerHTML = `
            <div class="modal-card auth-modal-card">
                <button class="modal-close-btn" onclick="closeAuthModal()">&times;</button>
                <div class="auth-tabs">
                    <button class="auth-tab-btn active" id="tab-login-btn" onclick="switchAuthTab('login')">Customer Login</button>
                    <button class="auth-tab-btn" id="tab-register-btn" onclick="switchAuthTab('register')">Register Account</button>
                </div>
                
                <!-- Login Form -->
                <form id="login-form" onsubmit="handleAuthLogin(event)">
                    <div class="form-group">
                        <label>Email Address</label>
                        <input type="email" id="login-email" placeholder="name@example.com" required value="customer@fitgear.pk">
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="login-password" placeholder="••••••••" required value="customer123">
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 14px;">
                        Demo Admin: <strong>admin@fitgear.pk</strong> / <strong>admin123</strong>
                    </p>
                    <button type="submit" class="btn btn-primary btn-block">Sign In to FitGear</button>
                </form>

                <!-- Register Form -->
                <form id="register-form" onsubmit="handleAuthRegister(event)" style="display: none;">
                    <div class="form-group">
                        <label>Full Name</label>
                        <input type="text" id="reg-name" placeholder="John Doe" required>
                    </div>
                    <div class="form-group">
                        <label>Email Address</label>
                        <input type="email" id="reg-email" placeholder="john@example.com" required>
                    </div>
                    <div class="form-group">
                        <label>Phone Number (WhatsApp)</label>
                        <input type="tel" id="reg-phone" placeholder="03000000000" required>
                    </div>
                    <div class="form-group">
                        <label>Password (min 6 characters)</label>
                        <input type="password" id="reg-password" placeholder="••••••••" required minlength="6">
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">Create FitGear Account</button>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
    }
    switchAuthTab(tab);
    modal.classList.add('active');
}

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('active');
}

function switchAuthTab(tab) {
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');
    const loginTabBtn = document.getElementById('tab-login-btn');
    const regTabBtn = document.getElementById('tab-register-btn');

    if (tab === 'login') {
        if (loginForm) loginForm.style.display = 'block';
        if (regForm) regForm.style.display = 'none';
        if (loginTabBtn) loginTabBtn.classList.add('active');
        if (regTabBtn) regTabBtn.classList.remove('active');
    } else {
        if (loginForm) loginForm.style.display = 'none';
        if (regForm) regForm.style.display = 'block';
        if (loginTabBtn) loginTabBtn.classList.remove('active');
        if (regTabBtn) regTabBtn.classList.add('active');
    }
}

async function handleAuthLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    const res = await apiRequest('/api/auth/login', 'POST', { email, password });
    if (res.success) {
        localStorage.setItem('fitgearToken', res.token);
        currentUser = res.user;
        updateAuthUI();
        closeAuthModal();
        showToast(`Welcome back, ${currentUser.name}!`, 'success');
        if (currentUser.role === 'admin' && window.location.pathname.includes('admin.html')) {
            initAdminPage();
        }
    } else {
        showToast(res.error || 'Login failed', 'info');
    }
}

async function handleAuthRegister(e) {
    e.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const password = document.getElementById('reg-password').value;

    const res = await apiRequest('/api/auth/register', 'POST', { name, email, phone, password });
    if (res.success) {
        localStorage.setItem('fitgearToken', res.token);
        currentUser = res.user;
        updateAuthUI();
        closeAuthModal();
        showToast(`Account created! Welcome, ${currentUser.name}`, 'success');
    } else {
        showToast(res.error || 'Registration failed', 'info');
    }
}

function handleLogout() {
    localStorage.removeItem('fitgearToken');
    currentUser = null;
    updateAuthUI();
    showToast('You have been logged out', 'info');
    if (window.location.pathname.includes('admin.html')) {
        window.location.href = 'index.html';
    }
}

// --- 3. HEADER & MINI-CART DRAWER ---
function updateHeaderBadges() {
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.querySelectorAll('.cart-count, #cart-count').forEach(el => {
        el.textContent = totalItems;
        el.style.display = totalItems > 0 ? 'flex' : 'none';
    });

    document.querySelectorAll('.wishlist-count, #wishlist-count').forEach(el => {
        el.textContent = wishlist.length;
        el.style.display = wishlist.length > 0 ? 'flex' : 'none';
    });
}

function updateWishlistIcons() {
    document.querySelectorAll('[data-wishlist-id]').forEach(btn => {
        const id = Number(btn.getAttribute('data-wishlist-id'));
        if (wishlist.includes(id)) {
            btn.classList.add('active');
            btn.innerHTML = '<i class="fas fa-heart" style="color: var(--accent);"></i>';
        } else {
            btn.classList.remove('active');
            btn.innerHTML = '<i class="far fa-heart"></i>';
        }
    });
}

function toggleWishlist(id) {
    id = Number(id);
    const product = products.find(p => p.id === id);
    if (!product) return;

    const index = wishlist.indexOf(id);
    if (index > -1) {
        wishlist.splice(index, 1);
        showToast(`Removed from Wishlist`, 'info');
    } else {
        wishlist.push(id);
        showToast(`Saved "${product.name}" to Wishlist!`, 'success');
    }
    saveWishlist();

    if (window.location.pathname.includes('wishlist.html')) {
        renderWishlistPage();
    }
}

function openCartDrawer() {
    const drawer = document.getElementById('cart-drawer');
    const overlay = document.getElementById('mobile-overlay');
    if (drawer) drawer.classList.add('active');
    if (overlay) overlay.classList.add('active');
}

function closeCartDrawer() {
    const drawer = document.getElementById('cart-drawer');
    const overlay = document.getElementById('mobile-overlay');
    const mobileNav = document.getElementById('mobile-nav');
    if (drawer) drawer.classList.remove('active');
    if (mobileNav) mobileNav.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

function renderMiniCart() {
    const drawerContainer = document.getElementById('cart-drawer-items');
    const drawerSubtotalEl = document.getElementById('drawer-subtotal-price');
    if (!drawerContainer) return;

    if (cart.length === 0) {
        drawerContainer.innerHTML = `
            <div class="empty-drawer-message">
                <i class="fas fa-shopping-bag"></i>
                <p>Your shopping bag is empty.</p>
                <a href="shop.html" class="btn btn-primary btn-sm" style="margin-top: 14px;" onclick="closeCartDrawer()">Shop Now</a>
            </div>
        `;
        if (drawerSubtotalEl) drawerSubtotalEl.textContent = formatPKR(0);
        return;
    }

    let subtotal = 0;
    drawerContainer.innerHTML = cart.map(item => {
        const lineTotal = item.price * item.quantity;
        subtotal += lineTotal;
        return `
            <div class="drawer-item" data-id="${item.id}">
                <img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">
                <div class="drawer-item-details">
                    <h4>${escapeHTML(item.name)}</h4>
                    <div class="drawer-item-price">${formatPKR(item.price)}</div>
                    <div class="drawer-item-actions">
                        <div class="qty-control">
                            <button class="qty-btn" onclick="updateCartItemQty(${item.id}, -1)">-</button>
                            <span class="qty-input">${item.quantity}</span>
                            <button class="qty-btn" onclick="updateCartItemQty(${item.id}, 1)">+</button>
                        </div>
                        <button class="drawer-remove-btn" onclick="removeFromCart(${item.id})" title="Remove Item">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    if (drawerSubtotalEl) drawerSubtotalEl.textContent = formatPKR(subtotal);
}

// --- 4. CART OPERATIONS WITH STOCK VALIDATION ---
function addToCart(productId, qty = 1) {
    productId = Number(productId);
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const existingIndex = cart.findIndex(item => item.id === productId);
    const currentQtyInCart = existingIndex > -1 ? cart[existingIndex].quantity : 0;
    const availableStock = product.stock_count || 15;

    if (currentQtyInCart + qty > availableStock) {
        showToast(`Stock limit reached! Only ${availableStock} units available in warehouse.`, 'info');
        return;
    }

    if (existingIndex > -1) {
        cart[existingIndex].quantity += qty;
    } else {
        cart.push({
            id: product.id,
            name: product.name,
            price: product.price,
            image: product.image,
            category: product.category_slug,
            quantity: qty
        });
    }

    saveCart();
    showToast(`Added ${qty}x "${product.name}" to cart!`, 'success');
    openCartDrawer();
}

function updateCartItemQty(id, delta) {
    id = Number(id);
    const item = cart.find(i => i.id === id);
    if (!item) return;

    const product = products.find(p => p.id === id);
    const maxStock = product ? product.stock_count : 15;

    if (delta > 0 && item.quantity + delta > maxStock) {
        showToast(`Maximum warehouse stock is ${maxStock} units`, 'info');
        return;
    }

    item.quantity += delta;
    if (item.quantity <= 0) {
        cart = cart.filter(i => i.id !== id);
    }
    saveCart();

    if (window.location.pathname.includes('cart.html')) {
        renderCartPage();
    } else if (window.location.pathname.includes('checkout.html')) {
        renderCheckoutSummary();
    }
}

function removeFromCart(id) {
    id = Number(id);
    const item = cart.find(i => i.id === id);
    cart = cart.filter(i => i.id !== id);
    saveCart();
    if (item) showToast(`Removed "${item.name}" from cart`, 'info');

    if (window.location.pathname.includes('cart.html')) {
        renderCartPage();
    } else if (window.location.pathname.includes('checkout.html')) {
        renderCheckoutSummary();
    }
}

// --- 5. DARAZ-INSPIRED PRODUCT CARD BUILDER ---
function createDarazProductCardHTML(p) {
    const isWishlisted = wishlist.includes(p.id);
    const discountPercent = Math.round(((p.original_price - p.price) / p.original_price) * 100);
    const totalStock = (p.stock_count + (p.sold_count || 10));
    const soldPercentage = Math.min(95, Math.max(15, Math.round(((p.sold_count || 10) / totalStock) * 100)));

    return `
        <div class="product-card" data-id="${p.id}" data-category="${escapeHTML(p.category_slug)}">
            <div class="product-image-wrap">
                <a href="product.html?id=${p.id}" style="display: block; width: 100%; height: 100%;">
                    <img src="${escapeHTML(p.image)}" alt="${escapeHTML(p.name)}" loading="lazy">
                </a>
                <div class="card-badges">
                    <span class="badge badge-accent">${escapeHTML(p.badge || 'Mall')}</span>
                    ${p.is_mall ? '<span class="daraz-mall-pill"><i class="fas fa-check-shield"></i> Mall</span>' : ''}
                </div>
                <div class="card-quick-actions">
                    <button class="card-action-btn ${isWishlisted ? 'active' : ''}" data-wishlist-id="${p.id}" onclick="toggleWishlist(${p.id})" title="Wishlist">
                        <i class="${isWishlisted ? 'fas' : 'far'} fa-heart"></i>
                    </button>
                    <button class="card-action-btn" onclick="openQuickView(${p.id})" title="Quick View">
                        <i class="fas fa-eye"></i>
                    </button>
                </div>
            </div>
            <div class="product-content">
                <span class="product-category-label">${escapeHTML(p.category_slug)}</span>
                <a href="product.html?id=${p.id}" style="text-decoration: none; color: inherit;">
                    <h4 class="product-title">${escapeHTML(p.name)}</h4>
                </a>
                
                <div class="product-pricing">
                    <span class="product-price">${formatPKR(p.price)}</span>
                    <span class="product-original-price">${formatPKR(p.original_price)}</span>
                    <span class="product-discount-pill">-${discountPercent}%</span>
                </div>

                <!-- Daraz Stock Claimed Meter -->
                <div class="stock-claimed-wrap">
                    <div class="stock-progress-label">
                        <span>Sold: ${p.sold_count || 0}</span>
                        <span>Only ${p.stock_count} Left</span>
                    </div>
                    <div class="stock-progress-bar">
                        <div class="stock-progress-fill" style="width: ${soldPercentage}%;"></div>
                    </div>
                </div>

                <div class="product-actions-grid">
                    <button class="btn btn-add-to-cart" onclick="addToCart(${p.id})">
                        <i class="fas fa-shopping-cart"></i> Add to Cart
                    </button>
                    <a href="https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`Hi, I want to order: ${p.name} (${formatPKR(p.price)})`)}" target="_blank" class="btn-card-wa" title="WhatsApp Order">
                        <i class="fab fa-whatsapp"></i>
                    </a>
                </div>
            </div>
        </div>
    `;
}

// --- 6. HOMEPAGE & FLASH DEALS ---
function initHomePage() {
    // 1. Flash Deals Section (Daraz Signature)
    const flashGrid = document.getElementById('flash-deals-grid');
    if (flashGrid) {
        const flashProducts = products.filter(p => p.is_flash_sale === 1);
        flashGrid.innerHTML = flashProducts.map(createDarazProductCardHTML).join('');
    }

    // 2. Just For You / Featured Grid
    const featuredGrid = document.getElementById('featured-products-grid');
    if (featuredGrid) {
        featuredGrid.innerHTML = products.slice(0, 8).map(createDarazProductCardHTML).join('');
    }

    // 3. Collectible Vouchers Grid
    renderVouchersHub();

    // 4. Live Countdown Timers
    startFlashCountdown();

    // 5. Genuine Reviews from Database
    renderHomePageReviews();
}

function startFlashCountdown() {
    function tick() {
        const now = new Date();
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const diff = Math.max(0, endOfDay - now);

        const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
        const minutes = Math.floor((diff / (1000 * 60)) % 60);
        const seconds = Math.floor((diff / 1000) % 60);

        const hrsEl = document.getElementById('flash-hrs');
        const minEl = document.getElementById('flash-min');
        const secEl = document.getElementById('flash-sec');

        if (hrsEl) hrsEl.textContent = String(hours).padStart(2, '0');
        if (minEl) minEl.textContent = String(minutes).padStart(2, '0');
        if (secEl) secEl.textContent = String(seconds).padStart(2, '0');
    }
    tick();
    setInterval(tick, 1000);
}

async function renderHomePageReviews() {
    const container = document.getElementById('homepage-reviews-container');
    if (!container) return;

    const res = await apiRequest('/api/reviews');
    if (res.success && res.reviews && res.reviews.length > 0) {
        container.innerHTML = res.reviews.map(r => `
            <div class="testimonial-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <div style="color: var(--gold); font-size: 0.85rem;">
                        ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}
                    </div>
                    <span style="font-size: 0.72rem; color: var(--success); font-weight: 700;">
                        <i class="fas fa-check-circle"></i> Verified Buyer
                    </span>
                </div>
                <h4 style="margin-bottom: 4px; font-size: 1rem;">${escapeHTML(r.user_name)} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 400;">(${escapeHTML(r.user_city)})</span></h4>
                <p style="font-size: 0.8rem; color: var(--accent); margin-bottom: 8px;"><i class="fas fa-dumbbell"></i> ${escapeHTML(r.product_name || 'Fitness Hardware')}</p>
                <p class="testimonial-text" style="font-style: italic; color: var(--text-secondary); margin-bottom: 0;">
                    "${escapeHTML(r.comment)}"
                </p>
            </div>
        `).join('');
    }
}

function renderVouchersHub() {
    const voucherContainer = document.getElementById('vouchers-grid');
    if (!voucherContainer || vouchers.length === 0) return;

    voucherContainer.innerHTML = vouchers.map(v => {
        const isCollected = collectedVouchers.includes(v.code);
        return `
            <div class="voucher-ticket ${isCollected ? 'collected' : ''}">
                <div class="voucher-info">
                    <h4>${escapeHTML(v.title)}</h4>
                    <p>Min Spend: <strong>${formatPKR(v.min_spend)}</strong></p>
                    <span class="voucher-code-badge">${escapeHTML(v.code)}</span>
                </div>
                <button class="btn btn-collect ${isCollected ? 'collected-btn' : ''}" onclick="collectVoucher('${escapeHTML(v.code)}')">
                    ${isCollected ? '<i class="fas fa-check"></i> COLLECTED' : 'COLLECT'}
                </button>
            </div>
        `;
    }).join('');
}

function collectVoucher(code) {
    if (!collectedVouchers.includes(code)) {
        collectedVouchers.push(code);
        localStorage.setItem('fitgearCollectedVouchers', JSON.stringify(collectedVouchers));
        showToast(`Voucher ${code} collected to your wallet!`, 'success');
        renderVouchersHub();
    }
}

// --- 7. SHOP PAGE (shop.html) ---
function initShopPage() {
    const productGrid = document.getElementById('shop-product-grid');
    if (!productGrid) return;

    const urlParams = new URLSearchParams(window.location.search);
    let activeCategory = urlParams.get('category') || 'all';
    let searchQuery = urlParams.get('search') || '';
    let maxPrice = 150000;
    let sortBy = 'featured';

    const priceSlider = document.getElementById('price-slider');
    const priceDisplay = document.getElementById('price-display-val');
    const sortSelect = document.getElementById('sort-select');
    const resultsCountEl = document.getElementById('shop-results-count');
    const categoryBtns = document.querySelectorAll('.category-filter-btn');

    categoryBtns.forEach(btn => {
        if (btn.getAttribute('data-category') === activeCategory) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    function applyFilters() {
        let filtered = products.filter(p => {
            const matchesCat = (activeCategory === 'all' || p.category_slug === activeCategory);
            const matchesPrice = p.price <= maxPrice;
            const matchesSearch = !searchQuery ||
                p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                p.category_slug.toLowerCase().includes(searchQuery.toLowerCase());
            return matchesCat && matchesPrice && matchesSearch;
        });

        if (sortBy === 'price-low') {
            filtered.sort((a, b) => a.price - b.price);
        } else if (sortBy === 'price-high') {
            filtered.sort((a, b) => b.price - a.price);
        } else if (sortBy === 'name-asc') {
            filtered.sort((a, b) => a.name.localeCompare(b.name));
        } else if (sortBy === 'name-desc') {
            filtered.sort((a, b) => b.name.localeCompare(a.name));
        } else if (sortBy === 'popular') {
            filtered.sort((a, b) => (b.sold_count || 0) - (a.sold_count || 0));
        }

        if (resultsCountEl) {
            resultsCountEl.innerHTML = `Showing <strong>${filtered.length}</strong> of ${products.length} products`;
        }

        if (filtered.length === 0) {
            productGrid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
                    <i class="fas fa-search" style="font-size: 3rem; color: var(--border-light); margin-bottom: 16px;"></i>
                    <h3>No gym equipment found</h3>
                    <p>Try adjusting your category filter, search query, or price limit.</p>
                    <button class="btn btn-secondary" onclick="resetShopFilters()" style="margin-top: 16px;">Reset All Filters</button>
                </div>
            `;
            return;
        }

        productGrid.innerHTML = filtered.map(createDarazProductCardHTML).join('');
        updateWishlistIcons();
    }

    categoryBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            categoryBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = btn.getAttribute('data-category');
            applyFilters();
        });
    });

    if (priceSlider) {
        priceSlider.addEventListener('input', (e) => {
            maxPrice = parseInt(e.target.value);
            if (priceDisplay) priceDisplay.textContent = formatPKR(maxPrice);
            applyFilters();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            sortBy = e.target.value;
            applyFilters();
        });
    }

    window.resetShopFilters = function() {
        activeCategory = 'all';
        searchQuery = '';
        maxPrice = 150000;
        if (priceSlider) priceSlider.value = 150000;
        if (priceDisplay) priceDisplay.textContent = formatPKR(150000);
        categoryBtns.forEach(b => b.classList.remove('active'));
        const allBtn = document.querySelector('[data-category="all"]');
        if (allBtn) allBtn.classList.add('active');
        applyFilters();
    };

    applyFilters();
}

// --- 8. PRODUCT DETAIL / QUICK VIEW MODAL WITH DATABASE REVIEWS ---
async function openQuickView(id) {
    id = Number(id);
    const modal = document.getElementById('quick-view-modal');
    const container = document.getElementById('quick-view-content');
    if (!modal || !container) return;

    // Fetch full product details with reviews from SQLite API
    const res = await apiRequest(`/api/products/${id}`);
    const product = res.success ? res.product : products.find(p => p.id === id);
    if (!product) return;

    const discountPercent = Math.round(((product.original_price - product.price) / product.original_price) * 100);
    const specs = product.specs || (product.specs_json ? JSON.parse(product.specs_json) : {});
    const specsHtml = Object.entries(specs).map(([key, val]) => `
        <div><strong>${escapeHTML(key)}:</strong> ${escapeHTML(val)}</div>
    `).join('');

    const reviews = product.reviews || [];
    const reviewsHtml = reviews.length === 0
        ? '<p style="color: var(--text-muted); font-size: 0.85rem;">No customer reviews yet. Be the first to review this product!</p>'
        : reviews.map(r => `
            <div style="background: var(--bg-surface); padding: 10px; border-radius: var(--radius-sm); margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.82rem; font-weight: 700;">
                    <span>${escapeHTML(r.user_name)} (${escapeHTML(r.user_city)})</span>
                    <span style="color: var(--gold);">${'★'.repeat(r.rating)}</span>
                </div>
                <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 4px 0 0;">${escapeHTML(r.comment)}</p>
            </div>
        `).join('');

    container.innerHTML = `
        <div class="qv-image-wrap">
            <img src="${escapeHTML(product.image)}" alt="${escapeHTML(product.name)}">
        </div>
        <div class="qv-details">
            <div style="margin-bottom: 8px;">
                <span class="badge badge-accent">${escapeHTML(product.badge || 'Mall')}</span>
                <span class="daraz-mall-pill"><i class="fas fa-check-shield"></i> FitGear Mall Verified</span>
            </div>
            <h3>${escapeHTML(product.name)}</h3>
            <div style="font-size: 0.85rem; color: var(--success); margin-bottom: 8px;">
                <i class="fas fa-check-circle"></i> In Stock (${product.stock_count} units ready to ship from Karachi Hub)
            </div>
            <div class="qv-price">
                ${formatPKR(product.price)}
                <span style="font-size: 1rem; color: var(--text-muted); text-decoration: line-through; margin-left: 10px;">${formatPKR(product.original_price)}</span>
                <span class="badge badge-success" style="margin-left: 8px;">Save ${discountPercent}%</span>
            </div>
            <p class="qv-description">${escapeHTML(product.description)}</p>
            <div class="qv-specs-list">${specsHtml}</div>

            <!-- Daraz-Style Delivery & Warranty Badges -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; font-size: 0.78rem; color: var(--text-muted);">
                <div><i class="fas fa-truck" style="color: var(--accent);"></i> Standard Delivery: 2-3 Days</div>
                <div><i class="fas fa-undo" style="color: var(--gold);"></i> 14 Days Easy Returns</div>
                <div><i class="fas fa-shield-alt" style="color: var(--success);"></i> 100% Authentic Steel</div>
                <div><i class="fas fa-money-bill-wave" style="color: var(--success);"></i> Cash on Delivery (COD)</div>
            </div>

            <!-- Customer Reviews Section -->
            <div style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 10px;">
                <h4 style="font-size: 0.95rem; margin-bottom: 8px;">Customer Ratings & Reviews (${reviews.length})</h4>
                <div style="max-height: 120px; overflow-y: auto; margin-bottom: 12px;">${reviewsHtml}</div>
                
                <!-- Add Review Input -->
                <div style="display: flex; gap: 8px;">
                    <input type="text" id="review-comment-input" placeholder="Share your feedback..." style="flex: 1; background: var(--bg-dark); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 0.8rem; color: #fff;">
                    <button class="btn btn-secondary btn-sm" onclick="submitProductReview(${product.id})">Post</button>
                </div>
            </div>

            <div class="qv-actions" style="margin-top: 18px;">
                <button class="btn btn-primary" onclick="addToCart(${product.id}); closeQuickView();" style="flex: 1;">
                    <i class="fas fa-shopping-cart"></i> Add to Cart
                </button>
                <a href="https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`Hi FitGear, I want to order: ${product.name} (${formatPKR(product.price)})`)}" target="_blank" class="btn btn-whatsapp" style="flex: 1;">
                    <i class="fab fa-whatsapp"></i> Buy on WhatsApp
                </a>
            </div>
        </div>
    `;

    modal.classList.add('active');
}

async function submitProductReview(productId) {
    const input = document.getElementById('review-comment-input');
    const comment = input ? input.value.trim() : '';
    if (!comment) return;

    const userName = currentUser ? currentUser.name : 'Verified Buyer';
    const userCity = currentUser ? currentUser.city : 'Pakistan';

    const res = await apiRequest('/api/reviews', 'POST', {
        product_id: productId,
        user_name: userName,
        user_city: userCity,
        rating: 5,
        comment: comment
    });

    if (res.success) {
        showToast('Review submitted and saved to database!', 'success');
        openQuickView(productId); // re-render modal with new review
    }
}

function closeQuickView() {
    const modal = document.getElementById('quick-view-modal');
    if (modal) modal.classList.remove('active');
}

// --- 9. CART & VOUCHER ENGINE (cart.html) ---
function renderCartPage() {
    const container = document.getElementById('cart-items-wrapper');
    const subtotalEl = document.getElementById('cart-page-subtotal');
    const discountEl = document.getElementById('cart-page-discount');
    const shippingEl = document.getElementById('cart-page-shipping');
    const totalEl = document.getElementById('cart-page-total');
    const thresholdBar = document.getElementById('threshold-bar');
    const thresholdMsg = document.getElementById('threshold-msg');
    const checkoutBtn = document.getElementById('cart-checkout-btn');

    if (!container) return;

    if (cart.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px 20px;">
                <i class="fas fa-shopping-cart" style="font-size: 3.5rem; color: var(--border-light); margin-bottom: 20px;"></i>
                <h3>Your shopping cart is empty</h3>
                <p>Looks like you haven't added any fitness equipment to your cart yet.</p>
                <a href="shop.html" class="btn btn-primary" style="margin-top: 20px;">Explore Gym Equipment</a>
            </div>
        `;
        if (subtotalEl) subtotalEl.textContent = formatPKR(0);
        if (discountEl) discountEl.textContent = formatPKR(0);
        if (shippingEl) shippingEl.textContent = formatPKR(0);
        if (totalEl) totalEl.textContent = formatPKR(0);
        if (checkoutBtn) {
            checkoutBtn.classList.add('disabled');
            checkoutBtn.removeAttribute('href');
        }
        return;
    }

    if (checkoutBtn) {
        checkoutBtn.classList.remove('disabled');
        checkoutBtn.setAttribute('href', 'checkout.html');
    }

    let subtotal = 0;
    container.innerHTML = cart.map(item => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        return `
            <div class="cart-item-row" data-id="${item.id}">
                <img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}" class="cart-item-img">
                <div class="cart-item-info">
                    <h4>${escapeHTML(item.name)}</h4>
                    <span class="item-unit-price">${formatPKR(item.price)} each</span>
                </div>
                <div>
                    <div class="qty-control" style="width: fit-content;">
                        <button class="qty-btn" onclick="updateCartItemQty(${item.id}, -1)">-</button>
                        <span class="qty-input">${item.quantity}</span>
                        <button class="qty-btn" onclick="updateCartItemQty(${item.id}, 1)">+</button>
                    </div>
                </div>
                <div class="cart-item-total">${formatPKR(itemTotal)}</div>
                <div>
                    <button class="btn-item-delete" onclick="removeFromCart(${item.id})" title="Delete Item">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    const shipping = subtotal >= 5000 ? 0 : 500;
    let discount = 0;

    if (appliedVoucher) {
        discount = appliedVoucher.discount_amount || (appliedVoucher.discount_type === 'percent' ? Math.round(subtotal * appliedVoucher.discount_value) : appliedVoucher.discount_value);
    }

    const finalTotal = Math.max(0, subtotal - discount + shipping);

    if (subtotalEl) subtotalEl.textContent = formatPKR(subtotal);
    if (discountEl) discountEl.textContent = `-${formatPKR(discount)}`;
    if (shippingEl) shippingEl.textContent = shipping === 0 ? 'FREE (Nationwide)' : formatPKR(shipping);
    if (totalEl) totalEl.textContent = formatPKR(finalTotal);

    if (thresholdBar && thresholdMsg) {
        const percentage = Math.min(100, Math.round((subtotal / 5000) * 100));
        thresholdBar.style.width = `${percentage}%`;
        if (subtotal >= 5000) {
            thresholdMsg.innerHTML = '🎉 <strong>Congratulations!</strong> You qualify for <strong>FREE Nationwide Delivery</strong>!';
        } else {
            thresholdMsg.innerHTML = `Add <strong>${formatPKR(5000 - subtotal)}</strong> more to get <strong>FREE Nationwide Delivery</strong>!`;
        }
    }
}

async function applyCouponCode() {
    const input = document.getElementById('coupon-input');
    const msg = document.getElementById('coupon-message');
    if (!input || !msg) return;

    const code = input.value.trim().toUpperCase();
    if (!code) return;

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Validate with SQLite backend
    const res = await apiRequest('/api/vouchers/validate', 'POST', { code, subtotal });
    if (res.success && res.voucher) {
        appliedVoucher = res.voucher;
        localStorage.setItem('fitgearAppliedVoucher', JSON.stringify(appliedVoucher));
        msg.className = 'coupon-message success';
        msg.textContent = `Voucher applied: -${formatPKR(res.voucher.discount_amount)}`;
        showToast(`Voucher ${code} applied successfully!`, 'success');
        renderCartPage();
    } else {
        msg.className = 'coupon-message error';
        msg.textContent = res.error || 'Invalid voucher code';
    }
}

// --- 10. REAL DATABASE CHECKOUT (checkout.html) ---
function renderCheckoutSummary() {
    const listContainer = document.getElementById('checkout-items-list');
    const subtotalEl = document.getElementById('co-subtotal');
    const discountEl = document.getElementById('co-discount');
    const shippingEl = document.getElementById('co-shipping');
    const totalEl = document.getElementById('co-total');
    const submitBtn = document.getElementById('checkout-submit-btn');

    if (!listContainer) return;

    if (cart.length === 0) {
        listContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Your cart is empty. Please add items to order.</p>';
        if (submitBtn) submitBtn.disabled = true;
        return;
    }

    if (submitBtn && !isOrderSubmitting) submitBtn.disabled = false;

    let subtotal = 0;
    listContainer.innerHTML = cart.map(item => {
        const lineTotal = item.price * item.quantity;
        subtotal += lineTotal;
        return `
            <div class="checkout-item-preview">
                <div>
                    <div class="checkout-item-name">${escapeHTML(item.name)}</div>
                    <div class="checkout-item-meta">Qty: ${item.quantity} × ${formatPKR(item.price)}</div>
                </div>
                <div class="checkout-item-price">${formatPKR(lineTotal)}</div>
            </div>
        `;
    }).join('');

    const shipping = subtotal >= 5000 ? 0 : 500;
    let discount = 0;
    if (appliedVoucher) {
        discount = appliedVoucher.discount_amount || (appliedVoucher.discount_type === 'percent' ? Math.round(subtotal * appliedVoucher.discount_value) : appliedVoucher.discount_value);
    }

    const finalTotal = Math.max(0, subtotal - discount + shipping);

    if (subtotalEl) subtotalEl.textContent = formatPKR(subtotal);
    if (discountEl) discountEl.textContent = `-${formatPKR(discount)}`;
    if (shippingEl) shippingEl.textContent = shipping === 0 ? 'FREE' : formatPKR(shipping);
    if (totalEl) totalEl.textContent = formatPKR(finalTotal);
}

function initCheckoutPage() {
    renderCheckoutSummary();

    // Auto-fill logged in user info
    if (currentUser) {
        const nameEl = document.getElementById('co-name');
        const phoneEl = document.getElementById('co-phone');
        const emailEl = document.getElementById('co-email');
        const cityEl = document.getElementById('co-city');
        const addrEl = document.getElementById('co-address');

        if (nameEl && !nameEl.value) nameEl.value = currentUser.name || '';
        if (phoneEl && !phoneEl.value) phoneEl.value = currentUser.phone || '';
        if (emailEl && !emailEl.value) emailEl.value = currentUser.email || '';
        if (cityEl && currentUser.city) cityEl.value = currentUser.city;
        if (addrEl && !addrEl.value) addrEl.value = currentUser.address || '';
    }

    // Payment method accordion toggles
    document.querySelectorAll('input[name="payment_method"]').forEach(radio => {
        radio.addEventListener('change', () => {
            document.querySelectorAll('.payment-details-accordion').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.payment-method-label').forEach(el => el.classList.remove('selected'));

            const label = radio.closest('.payment-method-label');
            if (label) label.classList.add('selected');

            const accordionId = `payment-details-${radio.value}`;
            const target = document.getElementById(accordionId);
            if (target) target.classList.add('active');
        });
    });

    const checkoutForm = document.getElementById('checkout-form');
    if (checkoutForm) {
        checkoutForm.addEventListener('submit', (e) => {
            e.preventDefault();
            handleCheckoutSubmit();
        });
    }
}

async function handleCheckoutSubmit() {
    if (cart.length === 0) {
        alert('Your cart is empty!');
        return;
    }

    if (isOrderSubmitting) return;

    const submitBtn = document.getElementById('checkout-submit-btn');
    if (submitBtn) {
        isOrderSubmitting = true;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Persisting Order in SQLite Database...';
    }

    const customerName = document.getElementById('co-name')?.value.trim();
    const customerPhone = document.getElementById('co-phone')?.value.trim();
    const customerEmail = document.getElementById('co-email')?.value.trim();
    const address = document.getElementById('co-address')?.value.trim();
    const city = document.getElementById('co-city')?.value.trim();
    const province = document.getElementById('co-province')?.value.trim();
    const postalCode = document.getElementById('co-postal')?.value.trim();
    const notes = document.getElementById('co-notes')?.value.trim() || '';
    const paymentMethodEl = document.querySelector('input[name="payment_method"]:checked');
    const paymentMethod = paymentMethodEl ? paymentMethodEl.value : 'cod';

    const subtotal = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    let discountAmount = 0;
    if (appliedVoucher) {
        discountAmount = appliedVoucher.discount_amount || (appliedVoucher.discount_type === 'percent' ? Math.round(subtotal * appliedVoucher.discount_value) : appliedVoucher.discount_value);
    }

    const payload = {
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: customerEmail,
        shipping_address: address,
        city,
        province,
        postal_code: postalCode,
        payment_method: paymentMethod,
        discount_amount: discountAmount,
        notes,
        items: cart.map(i => ({ id: i.id, quantity: i.quantity }))
    };

    // Save directly to SQLite backend!
    const res = await apiRequest('/api/orders', 'POST', payload);

    if (res.success) {
        const orderData = {
            order_number: res.order_number,
            tracking_number: res.tracking_number,
            customer_name: res.customer_name,
            total_amount: res.total_amount,
            city,
            address,
            phone: customerPhone,
            payment_method: paymentMethod.toUpperCase(),
            items: [...cart]
        };

        // Prepare WhatsApp dispatch notification link
        let waMsg = `*🏋️ NEW ORDER PLACED ON FITGEAR PAKISTAN: #${res.order_number}*%0A%0A`;
        waMsg += `*Customer:* ${customerName}%0A`;
        waMsg += `*Phone:* ${customerPhone}%0A`;
        waMsg += `*Address:* ${address}, ${city}, ${province}%0A`;
        waMsg += `*Payment:* ${paymentMethod.toUpperCase()}%0A`;
        waMsg += `*Total Amount:* ${formatPKR(res.total_amount)}%0A`;
        waMsg += `*Tracking #:* ${res.tracking_number}%0A%0A`;
        waMsg += `Please verify my order for express courier dispatch.`;

        const waUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(waMsg)}`;

        showOrderSuccessModal(orderData, waUrl);

        // Clear cart
        cart = [];
        saveCart();
        localStorage.removeItem('fitgearAppliedVoucher');
        appliedVoucher = null;
    } else {
        showToast(res.error || 'Failed to place order', 'info');
    }

    isOrderSubmitting = false;
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check-circle"></i> Place Order';
    }
}

function showOrderSuccessModal(order, waUrl) {
    const modal = document.getElementById('order-success-modal');
    const content = document.getElementById('order-success-content');
    if (!modal || !content) return;

    content.innerHTML = `
        <div class="success-icon-wrap">
            <i class="fas fa-check"></i>
        </div>
        <h3 style="text-align: center; margin-bottom: 8px;">Order Confirmed in Database!</h3>
        <p style="text-align: center; color: var(--text-secondary); margin-bottom: 20px;">
            Thank you, <strong>${escapeHTML(order.customer_name)}</strong>. Your order has been registered in the FitGear database.
        </p>

        <div class="order-receipt-box">
            <div class="receipt-header">
                <span>Order #: <strong>${escapeHTML(order.order_number)}</strong></span>
                <span class="badge badge-success">SAVED IN SQLITE</span>
            </div>
            <div style="margin-bottom: 12px; font-size: 0.85rem; line-height: 1.6;">
                <div><strong>Waybill Tracking:</strong> ${escapeHTML(order.tracking_number)}</div>
                <div><strong>Delivery Address:</strong> ${escapeHTML(order.address)}, ${escapeHTML(order.city)}</div>
                <div><strong>Contact:</strong> ${escapeHTML(order.phone)}</div>
                <div><strong>Payment:</strong> ${escapeHTML(order.payment_method)}</div>
            </div>
            <div style="border-top: 1px solid var(--border-color); padding-top: 10px;">
                <div style="display: flex; justify-content: space-between; font-weight: 800; font-family: var(--font-heading); font-size: 1.15rem; color: #ffffff;">
                    <span>Total Payable:</span>
                    <span style="color: var(--accent);">${formatPKR(order.total_amount)}</span>
                </div>
            </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
            <a href="${waUrl}" target="_blank" class="btn btn-whatsapp btn-block">
                <i class="fab fa-whatsapp"></i> Confirm Dispatch on WhatsApp
            </a>
            <a href="track-order.html?orderId=${encodeURIComponent(order.order_number)}" class="btn btn-secondary btn-block">
                <i class="fas fa-truck"></i> Live Track Order (${order.order_number})
            </a>
            <button class="btn btn-outline btn-block" onclick="window.print()">
                <i class="fas fa-print"></i> Print Invoice Receipt
            </button>
            <a href="shop.html" class="btn btn-block" style="color: var(--text-muted); font-size: 0.85rem;">
                Continue Shopping
            </a>
        </div>
    `;

    modal.classList.add('active');
}

// --- 11. REAL DATABASE ORDER TRACKING (track-order.html) ---
function initTrackOrderPage() {
    const input = document.getElementById('track-order-input');
    const form = document.getElementById('track-order-form');
    const resultBox = document.getElementById('track-results');

    if (!form || !resultBox) return;

    const urlParams = new URLSearchParams(window.location.search);
    const paramOrderId = urlParams.get('orderId');
    if (paramOrderId && input) {
        input.value = paramOrderId;
        executeDatabaseTracking(paramOrderId);
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = input.value.trim().toUpperCase();
        if (query) executeDatabaseTracking(query);
    });

    async function executeDatabaseTracking(query) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = '<div style="text-align: center; padding: 30px;"><i class="fas fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i><p style="margin-top: 10px;">Searching live database records...</p></div>';

        const res = await apiRequest(`/api/orders/track/${encodeURIComponent(query)}`);

        if (!res.success || !res.order) {
            resultBox.innerHTML = `
                <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 30px; text-align: center; margin-top: 24px;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 2.5rem; color: var(--gold); margin-bottom: 12px;"></i>
                    <h4>No Order Found</h4>
                    <p style="color: var(--text-muted);">Could not find active database order matching "<strong>${escapeHTML(query)}</strong>". Please double check your order number or phone.</p>
                </div>
            `;
            return;
        }

        const o = res.order;
        const items = o.items || [];
        const itemsListHtml = items.map(i => `
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; padding: 6px 0; border-bottom: 1px solid var(--border-color);">
                <span>${escapeHTML(i.product_name)} (x${i.quantity})</span>
                <span style="color: var(--accent); font-weight: 700;">${formatPKR(i.line_total)}</span>
            </div>
        `).join('');

        const statusSteps = ['Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
        const currentIdx = statusSteps.indexOf(o.order_status) !== -1 ? statusSteps.indexOf(o.order_status) : 0;

        resultBox.innerHTML = `
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 30px; margin-top: 30px;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 24px;">
                    <div>
                        <h3>Tracking Order: <span style="color: var(--accent);">${escapeHTML(o.order_number)}</span></h3>
                        <p style="margin-bottom: 0;">Waybill: <strong>${escapeHTML(o.tracking_number)}</strong> | Customer: <strong>${escapeHTML(o.customer_name)} (${escapeHTML(o.city)})</strong></p>
                    </div>
                    <span class="status-badge status-processing">${escapeHTML(o.order_status)}</span>
                </div>

                <div class="track-timeline">
                    <div class="timeline-step ${currentIdx >= 0 ? 'completed' : ''}">
                        <div class="step-icon"><i class="fas fa-check"></i></div>
                        <div class="step-content">
                            <h4>Order Placed & Verified in Database</h4>
                            <p>${escapeHTML(o.created_at)} - Payment: ${escapeHTML(o.payment_method)}</p>
                        </div>
                    </div>
                    <div class="timeline-step ${currentIdx >= 1 ? 'completed' : (currentIdx === 0 ? 'active' : '')}">
                        <div class="step-icon"><i class="fas fa-box-open"></i></div>
                        <div class="step-content">
                            <h4>Packed at Karachi Central Hub</h4>
                            <p>Reinforced foam protection applied for fitness equipment shipment.</p>
                        </div>
                    </div>
                    <div class="timeline-step ${currentIdx >= 2 ? 'completed' : (currentIdx === 1 ? 'active' : '')}">
                        <div class="step-icon"><i class="fas fa-truck-moving"></i></div>
                        <div class="step-content">
                            <h4>Dispatched via Courier Logistics</h4>
                            <p>Waybill #${escapeHTML(o.tracking_number)}. In transit to delivery address.</p>
                        </div>
                    </div>
                    <div class="timeline-step ${currentIdx >= 3 ? 'completed' : (currentIdx === 2 ? 'active' : '')}">
                        <div class="step-icon"><i class="fas fa-dolly"></i></div>
                        <div class="step-content">
                            <h4>Out for Delivery</h4>
                            <p>Courier rider will contact before doorstep delivery.</p>
                        </div>
                    </div>
                    <div class="timeline-step ${currentIdx >= 4 ? 'completed' : ''}">
                        <div class="step-icon"><i class="fas fa-home"></i></div>
                        <div class="step-content">
                            <h4>Delivered</h4>
                            <p>Package handover & Cash on Delivery payment collection.</p>
                        </div>
                    </div>
                </div>

                <div style="background: var(--bg-surface); padding: 18px; border-radius: var(--radius-md); margin-top: 24px;">
                    <h4 style="font-size: 0.95rem; margin-bottom: 10px;">Order Items Breakdown</h4>
                    ${itemsListHtml}
                    <div style="display: flex; justify-content: space-between; margin-top: 10px; font-weight: 800; font-size: 1rem; color: #fff;">
                        <span>Total Paid/Payable:</span>
                        <span style="color: var(--accent);">${formatPKR(o.total_amount)}</span>
                    </div>
                </div>

                <div style="margin-top: 24px; text-align: center;">
                    <a href="https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`Hi FitGear support, I would like an update on order #${o.order_number}`)}" target="_blank" class="btn btn-whatsapp">
                        <i class="fab fa-whatsapp"></i> Chat with Support Agent
                    </a>
                </div>
            </div>
        `;
    }
}

// --- 12. ADMIN PORTAL ENGINE (admin.html) ---
async function initAdminPage() {
    const adminMain = document.getElementById('admin-main-view');
    if (!adminMain) return;

    if (!currentUser || currentUser.role !== 'admin') {
        adminMain.innerHTML = `
            <div style="text-align: center; padding: 80px 20px;">
                <i class="fas fa-lock" style="font-size: 3.5rem; color: var(--accent); margin-bottom: 20px;"></i>
                <h2>Admin Authentication Required</h2>
                <p style="color: var(--text-secondary); max-width: 500px; margin: 0 auto 24px;">
                    This administration dashboard is protected by real server-side authorization. Please log in with the administrator credentials.
                </p>
                <button class="btn btn-primary" onclick="openAuthModal('login')">
                    <i class="fas fa-sign-in-alt"></i> Login as Admin
                </button>
            </div>
        `;
        return;
    }

    // Fetch live metrics from database
    const res = await apiRequest('/api/admin/metrics');
    if (!res.success) {
        showToast('Failed to load admin metrics', 'info');
        return;
    }

    // Fetch customer inquiries
    const inqRes = await apiRequest('/api/admin/inquiries');
    const inquiries = (inqRes.success && inqRes.inquiries) ? inqRes.inquiries : [];

    // Fetch registered customer directory
    const custRes = await apiRequest('/api/admin/customers');
    const customers = (custRes.success && custRes.customers) ? custRes.customers : [];

    // Fetch system diagnostics
    const sysRes = await apiRequest('/api/admin/system');
    const sys = (sysRes.success && sysRes.system) ? sysRes.system : {};

    const m = res.metrics;
    adminMain.innerHTML = `
        <div class="admin-header-strip">
            <div>
                <h2>Store Management Portal</h2>
                <p style="margin-bottom: 0;">Connected to SQLite Database: <code>fitgear.sqlite</code></p>
            </div>
            <div>
                <button class="btn btn-primary btn-sm" onclick="openAddProductModal()">
                    <i class="fas fa-plus"></i> Add New Equipment
                </button>
                <button class="btn btn-secondary btn-sm" onclick="handleLogout()" style="margin-left: 8px;">
                    <i class="fas fa-sign-out-alt"></i> Logout
                </button>
            </div>
        </div>

        <!-- Metric Analytics Cards -->
        <div class="admin-metrics-grid">
            <div class="admin-metric-card">
                <div class="metric-icon"><i class="fas fa-coins"></i></div>
                <div class="metric-data">
                    <h4>${formatPKR(m.revenue)}</h4>
                    <p>Total Real Revenue</p>
                </div>
            </div>
            <div class="admin-metric-card">
                <div class="metric-icon" style="color: var(--info); background: rgba(59, 130, 246, 0.12);"><i class="fas fa-shopping-cart"></i></div>
                <div class="metric-data">
                    <h4>${m.orders_count}</h4>
                    <p>Database Orders</p>
                </div>
            </div>
            <div class="admin-metric-card">
                <div class="metric-icon" style="color: var(--success); background: rgba(16, 185, 129, 0.12);"><i class="fas fa-users"></i></div>
                <div class="metric-data">
                    <h4>${m.customers_count}</h4>
                    <p>Registered Customers</p>
                </div>
            </div>
            <div class="admin-metric-card">
                <div class="metric-icon" style="color: var(--gold); background: rgba(245, 158, 11, 0.12);"><i class="fas fa-box"></i></div>
                <div class="metric-data">
                    <h4>${m.products_count}</h4>
                    <p>Total Equipment SKUs</p>
                </div>
            </div>
        </div>

        <!-- Live Orders Management Table -->
        <div class="admin-table-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; flex-wrap: wrap; gap: 10px;">
                <h3 style="margin-bottom: 0;"><i class="fas fa-clipboard-list" style="color: var(--accent);"></i> Customer Orders Management</h3>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 0.8rem; color: var(--text-muted);">Status Filter:</span>
                    <select onchange="filterAdminOrders(this.value)" id="admin-order-filter" style="background: var(--bg-surface); border: 1px solid var(--border-light); color: #fff; padding: 6px 10px; border-radius: var(--radius-sm); font-size: 0.8rem;">
                        <option value="all">All Statuses (${(m.recent_orders || []).length})</option>
                        <option value="Processing">Processing</option>
                        <option value="Packed">Packed</option>
                        <option value="Shipped">Shipped</option>
                        <option value="Out for Delivery">Out for Delivery</option>
                        <option value="Delivered">Delivered</option>
                        <option value="Cancelled">Cancelled</option>
                    </select>
                </div>
            </div>
            <table class="admin-table" id="admin-orders-table">
                <thead>
                    <tr>
                        <th>Order #</th>
                        <th>Customer</th>
                        <th>City / Phone</th>
                        <th>Total</th>
                        <th>Payment</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${(m.recent_orders || []).map(o => `
                        <tr data-status="${escapeHTML(o.order_status)}">
                            <td><strong>${escapeHTML(o.order_number)}</strong><br><small style="color: var(--text-muted);">${escapeHTML(o.tracking_number)}</small></td>
                            <td>${escapeHTML(o.customer_name)}</td>
                            <td>${escapeHTML(o.city)}<br><small>${escapeHTML(o.customer_phone)}</small></td>
                            <td style="color: var(--accent); font-weight: 700;">${formatPKR(o.total_amount)}</td>
                            <td><span class="badge badge-outline">${escapeHTML(o.payment_method)}</span></td>
                            <td><span class="status-badge status-${escapeHTML(o.order_status.toLowerCase())}">${escapeHTML(o.order_status)}</span></td>
                            <td>
                                <div style="display: flex; gap: 6px; align-items: center;">
                                    <select onchange="updateOrderStatus(${o.id}, this.value)" style="background: var(--bg-surface); border: 1px solid var(--border-light); color: #fff; padding: 4px 8px; border-radius: var(--radius-sm); font-size: 0.75rem;">
                                        <option value="Processing" ${o.order_status === 'Processing' ? 'selected' : ''}>Processing</option>
                                        <option value="Packed" ${o.order_status === 'Packed' ? 'selected' : ''}>Packed</option>
                                        <option value="Shipped" ${o.order_status === 'Shipped' ? 'selected' : ''}>Shipped</option>
                                        <option value="Out for Delivery" ${o.order_status === 'Out for Delivery' ? 'selected' : ''}>Out for Delivery</option>
                                        <option value="Delivered" ${o.order_status === 'Delivered' ? 'selected' : ''}>Delivered</option>
                                        <option value="Cancelled" ${o.order_status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                                    </select>
                                    <button class="btn btn-secondary btn-sm" onclick="printOrderInvoice('${escapeHTML(o.order_number)}')" title="Print Official Sales Invoice">
                                        <i class="fas fa-print"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Inventory Stock Manager with Create, Edit, Delete -->
        <div class="admin-table-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;">
                <h3 style="margin-bottom: 0;"><i class="fas fa-warehouse" style="color: var(--accent);"></i> Warehouse Product Inventory</h3>
                <button class="btn btn-primary btn-sm" onclick="openAddProductModal()">
                    <i class="fas fa-plus"></i> Add Equipment
                </button>
            </div>
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Product Name</th>
                        <th>Category</th>
                        <th>Price</th>
                        <th>Stock Count</th>
                        <th>Sold Count</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${products.map(p => `
                        <tr>
                            <td>#${p.id}</td>
                            <td><strong>${escapeHTML(p.name)}</strong></td>
                            <td><span class="badge badge-outline">${escapeHTML(p.category_slug)}</span></td>
                            <td>${formatPKR(p.price)}</td>
                            <td>
                                <input type="number" min="0" value="${p.stock_count}" onchange="quickUpdateStock(${p.id}, this.value)" style="width: 70px; background: var(--bg-surface); border: 1px solid var(--border-light); color: #fff; padding: 4px; border-radius: var(--radius-sm); font-weight: 700;">
                            </td>
                            <td>${p.sold_count || 0}</td>
                            <td>
                                <button class="btn btn-secondary btn-sm" onclick="openEditProductModal(${p.id})" title="Edit Equipment" style="margin-right: 4px;">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn btn-secondary btn-sm" onclick="deleteProduct(${p.id})" title="Delete Equipment" style="color: #ef4444;">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Customer Inquiries Inbox -->
        <div class="admin-table-container">
            <h3><i class="fas fa-envelope-open-text" style="color: var(--accent);"></i> Customer Inquiries Inbox (${inquiries.length})</h3>
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Sender</th>
                        <th>Subject</th>
                        <th>Message</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${inquiries.length === 0 ? '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No customer inquiries in database queue.</td></tr>' : inquiries.map(inq => `
                        <tr>
                            <td>#INQ-${inq.id}</td>
                            <td><strong>${escapeHTML(inq.name)}</strong><br><small style="color: var(--text-muted);">${escapeHTML(inq.phone)} | ${escapeHTML(inq.email)}</small></td>
                            <td><span class="badge badge-outline">${escapeHTML(inq.subject)}</span></td>
                            <td style="max-width: 250px; font-size: 0.8rem; color: var(--text-secondary);">${escapeHTML(inq.message)}</td>
                            <td style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(inq.created_at)}</td>
                            <td><span class="status-badge ${inq.status === 'Resolved' ? 'status-delivered' : 'status-processing'}">${escapeHTML(inq.status)}</span></td>
                            <td>
                                <select onchange="updateInquiryStatus(${inq.id}, this.value)" style="background: var(--bg-surface); border: 1px solid var(--border-light); color: #fff; padding: 4px 8px; border-radius: var(--radius-sm); font-size: 0.75rem;">
                                    <option value="New" ${inq.status === 'New' ? 'selected' : ''}>New</option>
                                    <option value="Contacted" ${inq.status === 'Contacted' ? 'selected' : ''}>Contacted</option>
                                    <option value="Resolved" ${inq.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
                                </select>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Registered Customers Directory -->
        <div class="admin-table-container">
            <h3><i class="fas fa-users" style="color: var(--accent);"></i> Registered Customers Directory (${customers.length})</h3>
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Customer Name</th>
                        <th>Contact / Phone</th>
                        <th>City / Address</th>
                        <th>Orders Placed</th>
                        <th>Total Spend</th>
                        <th>Member Since</th>
                    </tr>
                </thead>
                <tbody>
                    ${customers.length === 0 ? '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No registered customers yet.</td></tr>' : customers.map(c => `
                        <tr>
                            <td>#${c.id}</td>
                            <td><strong>${escapeHTML(c.name)}</strong></td>
                            <td>${escapeHTML(c.email)}<br><small style="color: var(--text-muted);">${escapeHTML(c.phone || 'N/A')}</small></td>
                            <td>${escapeHTML(c.city || 'Pakistan')}<br><small style="color: var(--text-muted);">${escapeHTML(c.address || 'Standard Address')}</small></td>
                            <td><span class="badge badge-accent">${c.orders_count} Orders</span></td>
                            <td style="color: var(--accent); font-weight: 700;">${formatPKR(c.total_spent)}</td>
                            <td style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(c.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Store Diagnostics & System Info -->
        <div class="admin-table-container">
            <h3><i class="fas fa-server" style="color: var(--accent);"></i> System Diagnostics & Payment Architecture</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">
                <div style="background: var(--bg-surface); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                    <small style="color: var(--text-muted);">Database Engine</small>
                    <h4 style="margin: 4px 0;">SQLite3 (WAL Mode)</h4>
                    <span style="font-size: 0.75rem; color: var(--success);"><i class="fas fa-check-circle"></i> File Size: ${sys.db_size_kb || 48} KB</span>
                </div>
                <div style="background: var(--bg-surface); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                    <small style="color: var(--text-muted);">Node Runtime</small>
                    <h4 style="margin: 4px 0;">Node.js ${sys.node_version || 'v22'}</h4>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">Platform: ${sys.platform || 'win32'}</span>
                </div>
                <div style="background: var(--bg-surface); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                    <small style="color: var(--text-muted);">Cash on Delivery (COD)</small>
                    <h4 style="margin: 4px 0; color: var(--success);"><i class="fas fa-check-circle"></i> Operational</h4>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">Nationwide coverage</span>
                </div>
                <div style="background: var(--bg-surface); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                    <small style="color: var(--text-muted);">JazzCash & EasyPaisa</small>
                    <h4 style="margin: 4px 0; color: var(--gold);"><i class="fas fa-info-circle"></i> Architecture Ready</h4>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">Awaiting merchant keys</span>
                </div>
            </div>
        </div>
    `;
}

function filterAdminOrders(status) {
    const rows = document.querySelectorAll('#admin-orders-table tbody tr');
    rows.forEach(r => {
        if (status === 'all' || r.getAttribute('data-status') === status) {
            r.style.display = '';
        } else {
            r.style.display = 'none';
        }
    });
}

async function updateInquiryStatus(inquiryId, newStatus) {
    const res = await apiRequest(`/api/admin/inquiries/${inquiryId}/status`, 'PATCH', { status: newStatus });
    if (res.success) {
        showToast(`Inquiry #${inquiryId} marked as ${newStatus}`, 'success');
        initAdminPage();
    } else {
        showToast(res.error || 'Failed to update inquiry status', 'info');
    }
}

function openEditProductModal(productId) {
    const p = products.find(item => item.id === Number(productId));
    if (!p) {
        showToast('Product not found', 'info');
        return;
    }

    let modal = document.getElementById('edit-product-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'edit-product-modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="modal-card" style="max-width: 550px;">
            <button class="modal-close-btn" onclick="document.getElementById('edit-product-modal').classList.remove('active')">&times;</button>
            <h3><i class="fas fa-edit" style="color: var(--accent);"></i> Edit Gym Equipment SKU #${p.id}</h3>
            <form onsubmit="handleUpdateProduct(event, ${p.id})" style="margin-top: 16px;">
                <div class="form-group">
                    <label>Product Name</label>
                    <input type="text" id="edit-prod-name" value="${escapeHTML(p.name)}" required>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label>Category</label>
                        <select id="edit-prod-cat">
                            <option value="weights" ${p.category_slug === 'weights' ? 'selected' : ''}>Free Weights</option>
                            <option value="cardio" ${p.category_slug === 'cardio' ? 'selected' : ''}>Cardio Equipment</option>
                            <option value="strength" ${p.category_slug === 'strength' ? 'selected' : ''}>Strength Training</option>
                            <option value="yoga" ${p.category_slug === 'yoga' ? 'selected' : ''}>Yoga and Recovery</option>
                            <option value="accessories" ${p.category_slug === 'accessories' ? 'selected' : ''}>Accessories</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Stock Count</label>
                        <input type="number" id="edit-prod-stock" value="${p.stock_count}" required min="0">
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label>Price (PKR)</label>
                        <input type="number" id="edit-prod-price" value="${p.price}" required min="100">
                    </div>
                    <div class="form-group">
                        <label>Original Price (PKR)</label>
                        <input type="number" id="edit-prod-orig" value="${p.original_price || p.price}">
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label>Badge</label>
                        <input type="text" id="edit-prod-badge" value="${escapeHTML(p.badge || 'Popular')}">
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; gap: 10px; margin-top: 26px;">
                        <input type="checkbox" id="edit-prod-flash" ${p.is_flash_sale ? 'checked' : ''} style="width: 20px; height: 20px;">
                        <label for="edit-prod-flash" style="margin-bottom: 0;">Flash Deal</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="edit-prod-desc" rows="3" required>${escapeHTML(p.description)}</textarea>
                </div>
                <button type="submit" class="btn btn-primary btn-block">Update Product in Database</button>
            </form>
        </div>
    `;
    modal.classList.add('active');
}

async function handleUpdateProduct(e, productId) {
    e.preventDefault();
    const name = document.getElementById('edit-prod-name').value.trim();
    const category_slug = document.getElementById('edit-prod-cat').value;
    const stock_count = Number(document.getElementById('edit-prod-stock').value);
    const price = Number(document.getElementById('edit-prod-price').value);
    const original_price = Number(document.getElementById('edit-prod-orig').value) || price;
    const badge = document.getElementById('edit-prod-badge').value.trim();
    const is_flash_sale = document.getElementById('edit-prod-flash').checked ? 1 : 0;
    const description = document.getElementById('edit-prod-desc').value.trim();

    const res = await apiRequest(`/api/products/${productId}`, 'PUT', {
        name,
        category_slug,
        price,
        original_price,
        stock_count,
        badge,
        is_flash_sale,
        flash_discount_percent: Math.round(((original_price - price) / original_price) * 100),
        description
    });

    if (res.success) {
        showToast(`Product #${productId} updated in database!`, 'success');
        const modal = document.getElementById('edit-product-modal');
        if (modal) modal.classList.remove('active');
        await loadInitialData();
        initAdminPage();
    } else {
        showToast(res.error || 'Failed to update product', 'info');
    }
}

async function handleContactSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('contact-name').value.trim();
    const phone = document.getElementById('contact-phone').value.trim();
    const email = document.getElementById('contact-email').value.trim();
    const subject = document.getElementById('contact-subject').value;
    const message = document.getElementById('contact-msg').value.trim();
    const noticeEl = document.getElementById('contact-form-notice');
    const submitBtn = document.getElementById('contact-submit-btn');

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    }

    const res = await apiRequest('/api/contact', 'POST', { name, phone, email, subject, message });

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Inquiry';
    }

    if (res.success) {
        showToast(`Inquiry #INQ-${res.inquiry_id} submitted successfully!`, 'success');
        if (noticeEl) {
            noticeEl.style.display = 'block';
            noticeEl.style.borderColor = 'var(--success)';
            noticeEl.style.color = '#fff';
            noticeEl.innerHTML = `
                <div style="display: flex; gap: 10px; align-items: flex-start;">
                    <i class="fas fa-check-circle" style="color: var(--success); font-size: 1.2rem; margin-top: 2px;"></i>
                    <div>
                        <strong>Inquiry #INQ-${res.inquiry_id} Recorded in Database:</strong>
                        <p style="margin: 4px 0 0; color: var(--text-secondary);">${escapeHTML(res.message)}</p>
                    </div>
                </div>
            `;
        }
        document.getElementById('contact-form').reset();
    } else {
        showToast(res.error || 'Failed to submit inquiry', 'info');
        if (noticeEl) {
            noticeEl.style.display = 'block';
            noticeEl.style.borderColor = '#ef4444';
            noticeEl.style.color = '#ef4444';
            noticeEl.textContent = res.error || 'Error submitting inquiry. Please call or WhatsApp us directly.';
        }
    }
}

async function updateOrderStatus(orderId, newStatus) {
    const res = await apiRequest(`/api/orders/${orderId}/status`, 'PATCH', { status: newStatus });
    if (res.success) {
        showToast(`Order status updated to ${newStatus}`, 'success');
        initAdminPage();
    } else {
        showToast(res.error || 'Failed to update order', 'info');
    }
}

async function quickUpdateStock(productId, newStock) {
    const p = products.find(prod => prod.id === productId);
    if (!p) return;

    p.stock_count = Number(newStock);
    const res = await apiRequest(`/api/products/${productId}`, 'PUT', p);
    if (res.success) {
        showToast(`Stock updated to ${newStock} units`, 'success');
    }
}

async function deleteProduct(productId) {
    if (!confirm('Are you sure you want to delete this equipment from database?')) return;
    const res = await apiRequest(`/api/products/${productId}`, 'DELETE');
    if (res.success) {
        showToast('Product deleted from database', 'info');
        loadInitialData();
    }
}

function openAddProductModal() {
    let modal = document.getElementById('add-product-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'add-product-modal';
        modal.innerHTML = `
            <div class="modal-card" style="max-width: 550px;">
                <button class="modal-close-btn" onclick="document.getElementById('add-product-modal').classList.remove('active')">&times;</button>
                <h3>Add New Gym Equipment SKU</h3>
                <form onsubmit="handleCreateProduct(event)" style="margin-top: 16px;">
                    <div class="form-group">
                        <label>Product Name</label>
                        <input type="text" id="add-prod-name" placeholder="e.g. Hex Dumbbell Set 20kg" required>
                    </div>
                    <div class="form-grid-2">
                        <div class="form-group">
                            <label>Category</label>
                            <select id="add-prod-cat">
                                <option value="weights">Free Weights</option>
                                <option value="cardio">Cardio Equipment</option>
                                <option value="strength">Strength Training</option>
                                <option value="yoga">Yoga and Recovery</option>
                                <option value="accessories">Accessories</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Stock Count</label>
                            <input type="number" id="add-prod-stock" value="15" required>
                        </div>
                    </div>
                    <div class="form-grid-2">
                        <div class="form-group">
                            <label>Price (PKR)</label>
                            <input type="number" id="add-prod-price" placeholder="15000" required>
                        </div>
                        <div class="form-group">
                            <label>Original Price (PKR)</label>
                            <input type="number" id="add-prod-orig" placeholder="18000">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea id="add-prod-desc" rows="3" placeholder="Equipment specifications and details..." required></textarea>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">Save Equipment to SQLite</button>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
    }
    modal.classList.add('active');
}

async function handleCreateProduct(e) {
    e.preventDefault();
    const name = document.getElementById('add-prod-name').value.trim();
    const category_slug = document.getElementById('add-prod-cat').value;
    const stock_count = Number(document.getElementById('add-prod-stock').value);
    const price = Number(document.getElementById('add-prod-price').value);
    const original_price = Number(document.getElementById('add-prod-orig').value) || price;
    const description = document.getElementById('add-prod-desc').value.trim();

    const res = await apiRequest('/api/products', 'POST', {
        name,
        category_slug,
        price,
        original_price,
        stock_count,
        description,
        badge: 'New Arrival',
        image: 'images/dumbbell_set.jpg'
    });

    if (res.success) {
        showToast('Equipment added to database!', 'success');
        document.getElementById('add-product-modal').classList.remove('active');
        loadInitialData();
    } else {
        showToast(res.error || 'Failed to create product', 'info');
    }
}

// --- 13. WISHLIST PAGE (wishlist.html) ---
function renderWishlistPage() {
    const container = document.getElementById('wishlist-grid');
    if (!container) return;

    if (wishlist.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
                <i class="far fa-heart" style="font-size: 3.5rem; color: var(--border-light); margin-bottom: 20px;"></i>
                <h3>Your Wishlist is Empty</h3>
                <p>Save your favorite gym equipment here to purchase later.</p>
                <a href="shop.html" class="btn btn-primary" style="margin-top: 20px;">Browse Equipment</a>
            </div>
        `;
        return;
    }

    const savedProducts = products.filter(p => wishlist.includes(p.id));
    container.innerHTML = savedProducts.map(createDarazProductCardHTML).join('');
    updateWishlistIcons();
}

// --- 14. DEDICATED PRODUCT DETAIL PAGE (product.html) ---
async function initProductDetailPage() {
    const container = document.getElementById('product-detail-view');
    if (!container) return;

    const urlParams = new URLSearchParams(window.location.search);
    const productId = Number(urlParams.get('id')) || (products[0] ? products[0].id : 1);

    container.innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <i class="fas fa-spinner fa-spin" style="font-size: 2.5rem; color: var(--accent); margin-bottom: 16px;"></i>
            <h3>Loading Equipment Specifications...</h3>
        </div>
    `;

    const res = await apiRequest(`/api/products/${productId}`);
    if (!res.success || !res.product) {
        container.innerHTML = `
            <div style="text-align: center; padding: 80px 20px;">
                <i class="fas fa-exclamation-circle" style="font-size: 3rem; color: var(--accent); margin-bottom: 16px;"></i>
                <h2>Equipment SKU Not Found</h2>
                <p style="color: var(--text-muted); margin-bottom: 24px;">The gym equipment you requested is unavailable or has been archived.</p>
                <a href="shop.html" class="btn btn-primary"><i class="fas fa-arrow-left"></i> Return to Equipment Catalog</a>
            </div>
        `;
        return;
    }

    const p = res.product;
    const isWishlisted = wishlist.includes(p.id);
    const discountPercent = Math.round(((p.original_price - p.price) / p.original_price) * 100);
    const specs = p.specs || {};
    const reviews = p.reviews || [];
    const avgRating = reviews.length > 0 ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1) : '5.0';

    // Related products from same category
    const related = products.filter(item => item.category_slug === p.category_slug && item.id !== p.id).slice(0, 4);

    container.innerHTML = `
        <!-- Breadcrumbs -->
        <div class="shop-breadcrumb" style="margin-bottom: 24px;">
            <a href="index.html">Home</a>
            <i class="fas fa-chevron-right" style="font-size: 0.7rem;"></i>
            <a href="shop.html">Shop</a>
            <i class="fas fa-chevron-right" style="font-size: 0.7rem;"></i>
            <a href="shop.html?category=${encodeURIComponent(p.category_slug)}" style="text-transform: capitalize;">${escapeHTML(p.category_slug)}</a>
            <i class="fas fa-chevron-right" style="font-size: 0.7rem;"></i>
            <span style="color: #fff; font-weight: 600;">${escapeHTML(p.name)}</span>
        </div>

        <div class="product-detail-layout">
            <!-- Left Column: Gallery -->
            <div class="product-gallery-wrap">
                <div class="product-main-img-card">
                    <img id="main-product-img" src="${escapeHTML(p.image)}" alt="${escapeHTML(p.name)}">
                    <div class="card-badges">
                        <span class="badge badge-accent">${escapeHTML(p.badge || 'Pro Grade')}</span>
                        ${p.is_mall ? '<span class="daraz-mall-pill"><i class="fas fa-check-shield"></i> Mall Certified</span>' : ''}
                    </div>
                </div>
                <div style="display: flex; gap: 12px; margin-top: 14px;">
                    <div style="width: 72px; height: 72px; border: 2px solid var(--accent); border-radius: var(--radius-sm); overflow: hidden; padding: 4px; background: var(--bg-card); cursor: pointer;">
                        <img src="${escapeHTML(p.image)}" style="width: 100%; height: 100%; object-fit: contain;">
                    </div>
                    <div style="width: 72px; height: 72px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; padding: 4px; background: var(--bg-card); cursor: pointer; opacity: 0.7;" onclick="showToast('High-resolution angle inspection', 'info')">
                        <img src="${escapeHTML(p.image)}" style="width: 100%; height: 100%; object-fit: contain; filter: brightness(0.9);">
                    </div>
                </div>
            </div>

            <!-- Right Column: Specs & Purchasing -->
            <div class="product-detail-meta">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <span class="product-category-label" style="font-size: 0.85rem; font-weight: 700; text-transform: uppercase;">${escapeHTML(p.category_slug)} Hardware</span>
                    <button class="card-action-btn ${isWishlisted ? 'active' : ''}" onclick="toggleWishlist(${p.id})" title="Save to Wishlist" style="width: 38px; height: 38px;">
                        <i class="${isWishlisted ? 'fas' : 'far'} fa-heart" style="${isWishlisted ? 'color: var(--accent);' : ''}"></i>
                    </button>
                </div>

                <h1 style="color: #fff; margin-top: 6px;">${escapeHTML(p.name)}</h1>

                <div class="p-rating-strip">
                    <div style="color: var(--gold);">${'★'.repeat(Math.round(Number(avgRating)))}${'☆'.repeat(5 - Math.round(Number(avgRating)))}</div>
                    <span style="font-weight: 700; color: #fff;">${avgRating}</span>
                    <span style="color: var(--text-muted);">&bull;</span>
                    <a href="#product-reviews-tab" onclick="switchProductTab('reviews')" style="color: var(--text-secondary); text-decoration: underline;">${reviews.length} Verified Reviews</a>
                    <span style="color: var(--text-muted);">&bull;</span>
                    <span style="color: var(--success); font-weight: 700;"><i class="fas fa-check-circle"></i> In Stock (${p.stock_count} units left)</span>
                </div>

                <div class="p-price-card">
                    <div style="display: flex; align-items: baseline;">
                        <span class="p-current-price">${formatPKR(p.price)}</span>
                        ${p.original_price > p.price ? `<span class="p-original-price">${formatPKR(p.original_price)}</span><span class="product-discount-pill" style="margin-left: 10px;">-${discountPercent}%</span>` : ''}
                    </div>
                    <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0; margin-top: 6px;">Inclusive of all applicable sales taxes across Pakistan</p>
                </div>

                <!-- Stock Claimed Bar -->
                <div class="stock-claimed-wrap" style="margin-bottom: 20px;">
                    <div class="stock-progress-label">
                        <span>Sold Nationwide: ${p.sold_count || 12} units</span>
                        <span>Warehouse Remaining: ${p.stock_count}</span>
                    </div>
                    <div class="stock-progress-bar">
                        <div class="stock-progress-fill" style="width: ${Math.min(95, Math.max(20, Math.round(((p.sold_count || 12) / ((p.stock_count || 1) + (p.sold_count || 12))) * 100)))}%;"></div>
                    </div>
                </div>

                <!-- Pakistani Delivery Estimator -->
                <div class="delivery-calc-box">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="font-size: 0.9rem; font-weight: 700; color: #fff;">
                            <i class="fas fa-shipping-fast" style="color: var(--accent);"></i> Nationwide Delivery Options
                        </div>
                        <span class="badge badge-success" id="p-delivery-badge">Free Shipping</span>
                    </div>
                    <label style="font-size: 0.78rem; color: var(--text-muted); margin-top: 8px; display: block;">Select Destination City:</label>
                    <select id="p-delivery-city" onchange="updateDeliveryEstimate(this.value, ${p.price})">
                        <option value="Karachi" selected>Karachi (Main Hub - 24 Hours)</option>
                        <option value="Lahore">Lahore (TCS/Trax - 1 to 2 Business Days)</option>
                        <option value="Islamabad">Islamabad / Rawalpindi (1 to 2 Business Days)</option>
                        <option value="Faisalabad">Faisalabad (1 to 2 Business Days)</option>
                        <option value="Multan">Multan (2 Business Days)</option>
                        <option value="Peshawar">Peshawar (2 to 3 Business Days)</option>
                        <option value="Quetta">Quetta (3 to 4 Business Days)</option>
                        <option value="Other">Other Cities across Pakistan</option>
                    </select>
                    <p id="p-delivery-desc" style="font-size: 0.8rem; color: var(--text-secondary); margin: 8px 0 0;">
                        Doorstep Delivery via Trax & TCS Express Logistics. Cash on Delivery (COD) supported.
                    </p>
                </div>

                <!-- Quantity & Actions -->
                <div style="margin-top: 24px;">
                    <label style="font-weight: 700; font-size: 0.85rem; display: block; margin-bottom: 8px;">Order Quantity:</label>
                    <div style="display: flex; gap: 14px; align-items: center; margin-bottom: 20px;">
                        <div class="qty-control" style="border: 1px solid var(--border-light); padding: 4px; border-radius: var(--radius-sm); background: var(--bg-card);">
                            <button class="qty-btn" onclick="adjustProductDetailQty(-1, ${p.stock_count})" style="width: 36px; height: 36px; font-size: 1.1rem;">-</button>
                            <span id="p-detail-qty" style="padding: 0 16px; font-weight: 800; font-size: 1.1rem; color: #fff;">1</span>
                            <button class="qty-btn" onclick="adjustProductDetailQty(1, ${p.stock_count})" style="width: 36px; height: 36px; font-size: 1.1rem;">+</button>
                        </div>
                        <span style="font-size: 0.8rem; color: var(--text-muted);">(Max warehouse order: ${p.stock_count} units)</span>
                    </div>

                    <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                        <button class="btn btn-primary btn-lg" onclick="addProductDetailToCart(${p.id}, false)" style="flex: 1; min-width: 170px;">
                            <i class="fas fa-shopping-cart"></i> Add to Cart
                        </button>
                        <button class="btn btn-secondary btn-lg" onclick="addProductDetailToCart(${p.id}, true)" style="flex: 1; min-width: 170px; background: #fff; color: #000; font-weight: 800;">
                            <i class="fas fa-bolt" style="color: var(--accent);"></i> Buy Now
                        </button>
                        <a href="https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`Hi FitGear Pakistan, I would like to order: ${p.name} (PKR ${p.price}). Please share delivery confirmation.`)}" target="_blank" class="btn btn-whatsapp btn-lg" style="width: 52px; padding: 0; display: flex; align-items: center; justify-content: center;" title="Order via WhatsApp">
                            <i class="fab fa-whatsapp" style="font-size: 1.4rem;"></i>
                        </a>
                    </div>
                </div>
            </div>
        </div>

        <!-- Tabbed Information -->
        <div style="margin-top: 50px;">
            <div class="p-tabs-nav">
                <div class="p-tab-btn active" id="tab-btn-specs" onclick="switchProductTab('specs')">
                    <i class="fas fa-list-ul"></i> Engineering & Specs
                </div>
                <div class="p-tab-btn" id="tab-btn-reviews" onclick="switchProductTab('reviews')">
                    <i class="fas fa-star"></i> Customer Reviews (${reviews.length})
                </div>
                <div class="p-tab-btn" id="tab-btn-shipping" onclick="switchProductTab('shipping')">
                    <i class="fas fa-shield-alt"></i> Warranty & Logistics
                </div>
            </div>

            <!-- Tab 1: Specs -->
            <div id="p-tab-content-specs">
                <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 30px;">
                    <h3 style="margin-bottom: 16px;">Product Specifications</h3>
                    <p style="color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px;">${escapeHTML(p.description)}</p>
                    <table class="specs-table">
                        <tbody>
                            <tr><td>Frame Construction</td><td>Commercial 11-Gauge Heavy Duty Carbon Steel</td></tr>
                            <tr><td>Finish & Coating</td><td>Double Powder Coated Anti-Scratch & Rust Resistant Finish</td></tr>
                            <tr><td>Category</td><td style="text-transform: capitalize;">${escapeHTML(p.category_slug)}</td></tr>
                            <tr><td>Dimensions</td><td>${escapeHTML(specs.dimensions || 'Engineered to International IPF / IFBB Standards')}</td></tr>
                            <tr><td>Max Load Capacity</td><td>${escapeHTML(specs.max_weight || '300 kg / 660 lbs Heavy Weight Class')}</td></tr>
                            <tr><td>Warranty Coverage</td><td>1 Year Structural Warranty + 6 Months Free Part Replacement</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Tab 2: Reviews -->
            <div id="p-tab-content-reviews" style="display: none;">
                <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 30px;">
                    <h3 style="margin-bottom: 4px;">Verified Customer Feedback</h3>
                    <p style="color: var(--text-muted); margin-bottom: 20px;">Genuine buyer reviews persisted in SQLite database</p>

                    <div style="display: grid; gap: 16px; margin-bottom: 36px;">
                        ${reviews.length === 0 ? '<p style="color: var(--text-muted);">No reviews posted yet. Be the first to review this equipment!</p>' : reviews.map(r => `
                            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 20px;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                                    <div style="color: var(--gold); font-size: 0.9rem;">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
                                    <span style="font-size: 0.75rem; color: var(--success); font-weight: 700;"><i class="fas fa-check-circle"></i> Verified Buyer (${escapeHTML(r.user_city)})</span>
                                </div>
                                <h4 style="margin-bottom: 4px; font-size: 0.95rem;">${escapeHTML(r.user_name)}</h4>
                                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0;">"${escapeHTML(r.comment)}"</p>
                            </div>
                        `).join('')}
                    </div>

                    <!-- Add Review Box -->
                    <div style="background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: var(--radius-md); padding: 24px;">
                        <h4>Submit a Verified Equipment Review</h4>
                        <form onsubmit="handleProductDetailReview(event, ${p.id})" style="margin-top: 14px;">
                            <div class="form-grid-2">
                                <div class="form-group">
                                    <label>Your Name</label>
                                    <input type="text" id="p-rev-name" placeholder="Muhammad Ali" required value="${currentUser ? escapeHTML(currentUser.name) : ''}">
                                </div>
                                <div class="form-group">
                                    <label>Your City</label>
                                    <input type="text" id="p-rev-city" placeholder="Karachi / Lahore" required value="${currentUser ? escapeHTML(currentUser.city || 'Karachi') : 'Karachi'}">
                                </div>
                            </div>
                            <div class="form-group">
                                <label>Star Rating</label>
                                <select id="p-rev-rating">
                                    <option value="5">5 Stars - Outstanding Heavy Build</option>
                                    <option value="4">4 Stars - Very Good Equipment</option>
                                    <option value="3">3 Stars - Average Quality</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Your Review</label>
                                <textarea id="p-rev-comment" rows="3" placeholder="Share your experience with build quality, finish, and delivery..." required></textarea>
                            </div>
                            <button type="submit" class="btn btn-primary">Post Review to Database</button>
                        </form>
                    </div>
                </div>
            </div>

            <!-- Tab 3: Shipping & Warranty -->
            <div id="p-tab-content-shipping" style="display: none;">
                <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 30px;">
                    <h3>Nationwide Logistics & Warranty Guarantee</h3>
                    <div class="trust-grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 24px;">
                        <div class="trust-item">
                            <div class="trust-icon"><i class="fas fa-truck"></i></div>
                            <div class="trust-info">
                                <h4>Trax & TCS Logistics</h4>
                                <p>Heavy-duty reinforced foam crating to prevent scratch or transit denting.</p>
                            </div>
                        </div>
                        <div class="trust-item">
                            <div class="trust-icon"><i class="fas fa-money-bill-wave"></i></div>
                            <div class="trust-info">
                                <h4>Doorstep COD</h4>
                                <p>Inspect package seals before handing over cash payment to courier.</p>
                            </div>
                        </div>
                        <div class="trust-item">
                            <div class="trust-icon"><i class="fas fa-tools"></i></div>
                            <div class="trust-info">
                                <h4>Official Parts Support</h4>
                                <p>Karachi workshop stocks replacement cables, pulleys, and motor brushes.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Related Equipment Showcase -->
        ${related.length > 0 ? `
            <div style="margin-top: 60px;">
                <div class="section-header" style="text-align: left; margin-bottom: 24px;">
                    <span class="sub-title">Complete Your Training Setup</span>
                    <h2>Related Gym Hardware</h2>
                </div>
                <div class="product-grid">
                    ${related.map(createDarazProductCardHTML).join('')}
                </div>
            </div>
        ` : ''}
    `;

    updateWishlistIcons();
}

function adjustProductDetailQty(delta, maxStock) {
    const el = document.getElementById('p-detail-qty');
    if (!el) return;
    let qty = Number(el.textContent) || 1;
    qty += delta;
    if (qty < 1) qty = 1;
    if (qty > maxStock) {
        showToast(`Only ${maxStock} units available in warehouse`, 'info');
        qty = maxStock;
    }
    el.textContent = qty;
}

function addProductDetailToCart(productId, buyNow = false) {
    const qtyEl = document.getElementById('p-detail-qty');
    const qty = qtyEl ? (Number(qtyEl.textContent) || 1) : 1;
    addToCart(productId, qty);
    if (buyNow) {
        window.location.href = 'checkout.html';
    }
}

function switchProductTab(tab) {
    ['specs', 'reviews', 'shipping'].forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        const content = document.getElementById(`p-tab-content-${t}`);
        if (btn) btn.classList.toggle('active', t === tab);
        if (content) content.style.display = t === tab ? 'block' : 'none';
    });
}

function updateDeliveryEstimate(city, price) {
    const desc = document.getElementById('p-delivery-desc');
    const badge = document.getElementById('p-delivery-badge');
    if (!desc || !badge) return;

    if (city === 'Karachi') {
        desc.textContent = 'Karachi Central Hub: Express 24-Hour Doorstep Delivery via TCS / Trax. COD available.';
        badge.textContent = price >= 5000 ? 'Free Shipping' : 'PKR 300 Delivery';
    } else if (city === 'Lahore' || city === 'Islamabad') {
        desc.textContent = `${city}: Express Courier Dispatch (1 to 2 Business Days). COD available.`;
        badge.textContent = price >= 5000 ? 'Free Shipping' : 'PKR 500 Delivery';
    } else {
        desc.textContent = 'Nationwide Courier Transit (2 to 4 Business Days). Doorstep Cash on Delivery.';
        badge.textContent = price >= 5000 ? 'Free Shipping' : 'PKR 500 Delivery';
    }
}

async function handleProductDetailReview(e, productId) {
    e.preventDefault();
    const name = document.getElementById('p-rev-name').value.trim();
    const city = document.getElementById('p-rev-city').value.trim();
    const rating = Number(document.getElementById('p-rev-rating').value);
    const comment = document.getElementById('p-rev-comment').value.trim();

    const res = await apiRequest('/api/reviews', 'POST', { product_id: productId, user_name: name, user_city: city, rating, comment });
    if (res.success) {
        showToast('Verified review saved to database!', 'success');
        initProductDetailPage();
    } else {
        showToast(res.error || 'Failed to submit review', 'info');
    }
}

// --- 15. CUSTOMER ACCOUNT & ORDER HISTORY (account.html) ---
async function initAccountPage() {
    const container = document.getElementById('account-main-view');
    if (!container) return;

    if (!currentUser) {
        container.innerHTML = `
            <div style="text-align: center; padding: 80px 20px;">
                <i class="fas fa-user-lock" style="font-size: 3.5rem; color: var(--accent); margin-bottom: 20px;"></i>
                <h2>Customer Account Access</h2>
                <p style="color: var(--text-secondary); max-width: 480px; margin: 0 auto 24px;">
                    Sign in to track orders, access your collected discount vouchers, update shipping addresses, and download official tax invoices.
                </p>
                <button class="btn btn-primary" onclick="openAuthModal('login')">
                    <i class="fas fa-sign-in-alt"></i> Sign In to Account
                </button>
            </div>
        `;
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const activeTab = urlParams.get('tab') || 'orders';

    // Fetch user orders
    const ordersRes = await apiRequest('/api/orders');
    const myOrders = (ordersRes.success && ordersRes.orders) ? ordersRes.orders : [];

    container.innerHTML = `
        <div class="account-grid">
            <!-- Sidebar -->
            <div class="account-sidebar-card">
                <div class="account-user-badge-header">
                    <div class="account-user-avatar">
                        <i class="fas fa-user"></i>
                    </div>
                    <h3 style="margin-bottom: 4px;">${escapeHTML(currentUser.name)}</h3>
                    <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 8px;">${escapeHTML(currentUser.email)}</p>
                    <span class="badge badge-accent" style="font-size: 0.72rem;">${currentUser.role === 'admin' ? 'ADMINISTRATOR' : 'VERIFIED CUSTOMER'}</span>
                </div>

                <div class="account-nav-list">
                    <button class="account-nav-btn ${activeTab === 'orders' ? 'active' : ''}" onclick="switchAccountTab('orders')">
                        <i class="fas fa-box"></i> My Orders (${myOrders.length})
                    </button>
                    <button class="account-nav-btn ${activeTab === 'profile' ? 'active' : ''}" onclick="switchAccountTab('profile')">
                        <i class="fas fa-id-card"></i> Profile & Address
                    </button>
                    <button class="account-nav-btn ${activeTab === 'vouchers' ? 'active' : ''}" onclick="switchAccountTab('vouchers')">
                        <i class="fas fa-ticket-alt"></i> My Vouchers (${collectedVouchers.length})
                    </button>
                    <button class="account-nav-btn ${activeTab === 'wishlist' ? 'active' : ''}" onclick="switchAccountTab('wishlist')">
                        <i class="fas fa-heart"></i> Saved Wishlist (${wishlist.length})
                    </button>
                    <button class="account-nav-btn" onclick="handleLogout()" style="color: #ef4444; margin-top: 14px; border-top: 1px solid var(--border-color);">
                        <i class="fas fa-sign-out-alt"></i> Sign Out
                    </button>
                </div>
            </div>

            <!-- Content Area -->
            <div class="account-content-card">
                <!-- Tab 1: Orders -->
                <div id="acc-tab-orders" style="${activeTab === 'orders' ? 'display: block;' : 'display: none;'}">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                        <h2 style="font-size: 1.4rem; margin-bottom: 0;">Order History (${myOrders.length})</h2>
                        <a href="shop.html" class="btn btn-primary btn-sm"><i class="fas fa-plus"></i> New Order</a>
                    </div>

                    ${myOrders.length === 0 ? `
                        <div style="text-align: center; padding: 60px 20px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px solid var(--border-color);">
                            <i class="fas fa-shopping-bag" style="font-size: 3rem; color: var(--border-light); margin-bottom: 16px;"></i>
                            <h3>No Orders Yet</h3>
                            <p style="color: var(--text-muted);">Explore our professional gym equipment catalog to place your first order.</p>
                            <a href="shop.html" class="btn btn-primary" style="margin-top: 14px;">Shop Equipment</a>
                        </div>
                    ` : myOrders.map(o => `
                        <div class="account-order-card">
                            <div class="account-order-header">
                                <div>
                                    <h4 style="margin-bottom: 2px;">Order <span style="color: var(--accent);">${escapeHTML(o.order_number)}</span></h4>
                                    <small style="color: var(--text-muted);">${escapeHTML(o.created_at)} &bull; Waybill: <strong>${escapeHTML(o.tracking_number)}</strong></small>
                                </div>
                                <span class="status-badge status-${escapeHTML(o.order_status.toLowerCase())}">${escapeHTML(o.order_status)}</span>
                            </div>
                            <div style="padding: 12px 0;">
                                ${(o.items || []).map(i => `
                                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                                        <div style="display: flex; align-items: center; gap: 12px;">
                                            <img src="${escapeHTML(i.product_image || 'images/dumbbell_set.jpg')}" style="width: 44px; height: 44px; object-fit: contain; border-radius: var(--radius-sm); background: var(--bg-dark);">
                                            <div>
                                                <div style="font-weight: 700; font-size: 0.9rem;">${escapeHTML(i.product_name)}</div>
                                                <div style="font-size: 0.75rem; color: var(--text-muted);">${formatPKR(i.unit_price)} &times; ${i.quantity}</div>
                                            </div>
                                        </div>
                                        <span style="font-weight: 700; color: #fff;">${formatPKR(i.line_total)}</span>
                                    </div>
                                `).join('')}
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 14px; margin-top: 8px; flex-wrap: wrap; gap: 10px;">
                                <div style="font-size: 0.95rem;">
                                    <span>Total: </span>
                                    <strong style="color: var(--accent); font-size: 1.1rem;">${formatPKR(o.total_amount)}</strong>
                                    <span style="font-size: 0.75rem; color: var(--text-muted);">(${escapeHTML(o.payment_method)})</span>
                                </div>
                                <div style="display: flex; gap: 8px;">
                                    <a href="track-order.html?orderId=${encodeURIComponent(o.order_number)}" class="btn btn-secondary btn-sm">
                                        <i class="fas fa-truck"></i> Track Waybill
                                    </a>
                                    <button class="btn btn-primary btn-sm" onclick="printOrderInvoice('${escapeHTML(o.order_number)}')">
                                        <i class="fas fa-print"></i> Tax Invoice
                                    </button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Tab 2: Profile Form -->
                <div id="acc-tab-profile" style="${activeTab === 'profile' ? 'display: block;' : 'display: none;'}">
                    <h2 style="font-size: 1.4rem; margin-bottom: 20px;">Shipping Profile & Details</h2>
                    <form onsubmit="handleProfileUpdate(event)" style="background: var(--bg-card); padding: 28px; border-radius: var(--radius-lg); border: 1px solid var(--border-color);">
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label>Full Name</label>
                                <input type="text" id="acc-name" value="${escapeHTML(currentUser.name)}" required>
                            </div>
                            <div class="form-group">
                                <label>Email Address</label>
                                <input type="email" id="acc-email" value="${escapeHTML(currentUser.email)}" disabled style="opacity: 0.6; cursor: not-allowed;">
                            </div>
                        </div>
                        <div class="form-grid-2">
                            <div class="form-group">
                                <label>Phone Number (WhatsApp)</label>
                                <input type="tel" id="acc-phone" value="${escapeHTML(currentUser.phone || '')}" required>
                            </div>
                            <div class="form-group">
                                <label>City</label>
                                <input type="text" id="acc-city" value="${escapeHTML(currentUser.city || 'Karachi')}" required>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Default Doorstep Delivery Address</label>
                            <textarea id="acc-address" rows="3" placeholder="House/Street, Phase, City..." required>${escapeHTML(currentUser.address || '')}</textarea>
                        </div>
                        <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Save Profile in SQLite</button>
                    </form>
                </div>

                <!-- Tab 3: Vouchers -->
                <div id="acc-tab-vouchers" style="${activeTab === 'vouchers' ? 'display: block;' : 'display: none;'}">
                    <h2 style="font-size: 1.4rem; margin-bottom: 20px;">Collected Vouchers Wallet</h2>
                    <div class="vouchers-grid" style="grid-template-columns: 1fr;">
                        ${vouchers.map(v => {
                            const isCol = collectedVouchers.includes(v.code);
                            return `
                                <div class="voucher-ticket ${isCol ? 'collected' : ''}">
                                    <div class="voucher-info">
                                        <h4>${escapeHTML(v.title)}</h4>
                                        <p>Min Spend: <strong>${formatPKR(v.min_spend)}</strong> &bull; ${escapeHTML(v.expiry_text || 'Active')}</p>
                                        <span class="voucher-code-badge">${escapeHTML(v.code)}</span>
                                    </div>
                                    <button class="btn btn-collect ${isCol ? 'collected-btn' : ''}" onclick="collectVoucher('${escapeHTML(v.code)}')">
                                        ${isCol ? '<i class="fas fa-check"></i> IN WALLET' : 'COLLECT'}
                                    </button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <!-- Tab 4: Wishlist -->
                <div id="acc-tab-wishlist" style="${activeTab === 'wishlist' ? 'display: block;' : 'display: none;'}">
                    <h2 style="font-size: 1.4rem; margin-bottom: 20px;">Saved Hardware Wishlist (${wishlist.length})</h2>
                    <div class="product-grid" style="grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));">
                        ${products.filter(p => wishlist.includes(p.id)).map(createDarazProductCardHTML).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;

    updateWishlistIcons();
}

function switchAccountTab(tab) {
    const tabs = ['orders', 'profile', 'vouchers', 'wishlist'];
    tabs.forEach(t => {
        const el = document.getElementById(`acc-tab-${t}`);
        if (el) el.style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('.account-nav-btn').forEach(b => {
        b.classList.remove('active');
        if (b.innerText.toLowerCase().includes(tab)) b.classList.add('active');
    });
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    const name = document.getElementById('acc-name').value.trim();
    const phone = document.getElementById('acc-phone').value.trim();
    const city = document.getElementById('acc-city').value.trim();
    const address = document.getElementById('acc-address').value.trim();

    const res = await apiRequest('/api/auth/profile', 'PATCH', { name, phone, city, address });
    if (res.success) {
        showToast('Profile updated in database successfully!', 'success');
        currentUser = res.user;
        updateAuthUI();
        initAccountPage();
    } else {
        showToast(res.error || 'Failed to update profile', 'info');
    }
}

// --- 16. PRINTABLE SALES TAX INVOICE ENGINE ---
async function printOrderInvoice(orderNumber) {
    const res = await apiRequest(`/api/orders/track/${encodeURIComponent(orderNumber)}`);
    if (!res.success || !res.order) {
        showToast('Order not found for invoice generation', 'info');
        return;
    }

    const o = res.order;
    const items = o.items || [];

    let modal = document.getElementById('invoice-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'invoice-modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="modal-card invoice-modal-card">
            <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px;">
                <span style="font-weight: 700; color: #111;"><i class="fas fa-file-invoice"></i> Official Sales Tax Invoice Preview</span>
                <div>
                    <button class="btn btn-primary btn-sm" onclick="window.print()" style="margin-right: 8px;">
                        <i class="fas fa-print"></i> Print / Save as PDF
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('invoice-modal').classList.remove('active')">&times; Close</button>
                </div>
            </div>

            <div class="invoice-header">
                <div>
                    <h2 style="font-size: 1.8rem; font-weight: 900; color: #d32f2f; margin-bottom: 2px;">FITGEAR PAKISTAN</h2>
                    <p style="font-size: 0.85rem; color: #4b5563; margin-bottom: 0;">Saddar, Karachi, Sindh, Pakistan (Demo)</p>
                    <p style="font-size: 0.82rem; color: #6b7280; margin-bottom: 0;">NTN: 8931204-7 &bull; STRN: 3277876192138 &bull; Phone: +92 300 0000000</p>
                </div>
                <div style="text-align: right;">
                    <h3 style="font-size: 1.2rem; color: #111; margin-bottom: 4px;">SALES TAX INVOICE</h3>
                    <p style="font-size: 0.85rem; margin-bottom: 2px;">Invoice #: <strong>INV-${escapeHTML(o.order_number)}</strong></p>
                    <p style="font-size: 0.82rem; color: #6b7280; margin-bottom: 0;">Date: ${escapeHTML(o.created_at)}</p>
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                <div>
                    <h4 style="font-size: 0.85rem; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Billed & Shipped To:</h4>
                    <p style="font-weight: 700; margin-bottom: 2px; color: #111;">${escapeHTML(o.customer_name)}</p>
                    <p style="font-size: 0.85rem; color: #374151; margin-bottom: 2px;">${escapeHTML(o.shipping_address)}, ${escapeHTML(o.city)}</p>
                    <p style="font-size: 0.85rem; color: #374151; margin-bottom: 0;">Phone: ${escapeHTML(o.customer_phone)} | ${escapeHTML(o.customer_email || 'N/A')}</p>
                </div>
                <div>
                    <h4 style="font-size: 0.85rem; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Fulfillment & Logistics:</h4>
                    <p style="font-size: 0.85rem; margin-bottom: 2px;">Payment Method: <strong>${escapeHTML(o.payment_method)}</strong></p>
                    <p style="font-size: 0.85rem; margin-bottom: 2px;">Courier Logistics: <strong>Trax & TCS Express</strong></p>
                    <p style="font-size: 0.85rem; margin-bottom: 0;">Waybill Consignment: <strong>${escapeHTML(o.tracking_number)}</strong></p>
                </div>
            </div>

            <table class="invoice-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Item Description</th>
                        <th>Qty</th>
                        <th>Unit Price</th>
                        <th style="text-align: right;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map((i, idx) => `
                        <tr>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHTML(i.product_name)}</strong></td>
                            <td>${i.quantity}</td>
                            <td>${formatPKR(i.unit_price)}</td>
                            <td style="text-align: right; font-weight: 700;">${formatPKR(i.line_total)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
                <div style="width: 280px; font-size: 0.9rem;">
                    <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                        <span>Subtotal:</span>
                        <span>${formatPKR(o.subtotal)}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #059669;">
                        <span>Discount Voucher:</span>
                        <span>-${formatPKR(o.discount_amount || 0)}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                        <span>Shipping Delivery:</span>
                        <span>${formatPKR(o.shipping_fee || 0)}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 2px solid #111; font-weight: 900; font-size: 1.1rem; color: #d32f2f;">
                        <span>Total Payable:</span>
                        <span>${formatPKR(o.total_amount)}</span>
                    </div>
                </div>
            </div>

            <div style="margin-top: 36px; padding-top: 16px; border-top: 1px dashed #d1d5db; display: flex; justify-content: space-between; align-items: flex-end; font-size: 0.78rem; color: #6b7280;">
                <div>
                    <p style="margin-bottom: 2px;">This is an official computer generated commercial sales tax invoice from FitGear Pakistan.</p>
                    <p style="margin-bottom: 0;">For warranty claims or part assistance, WhatsApp +92 300 0000000.</p>
                </div>
                <div style="text-align: center; border-top: 1px solid #9ca3af; padding-top: 4px; width: 140px;">
                    Authorized Signature
                </div>
            </div>
        </div>
    `;

    modal.classList.add('active');
}

// --- 17. INITIALIZATION ON DOM READY ---
document.addEventListener('DOMContentLoaded', () => {
    loadInitialData();

    // Mobile nav toggle
    const menuToggle = document.getElementById('menu-toggle');
    const mobileNav = document.getElementById('mobile-nav');
    const mobileClose = document.getElementById('mobile-nav-close');
    const overlay = document.getElementById('mobile-overlay');

    if (menuToggle && mobileNav) {
        menuToggle.addEventListener('click', () => {
            mobileNav.classList.add('active');
            if (overlay) overlay.classList.add('active');
        });
    }

    if (mobileClose && mobileNav) {
        mobileClose.addEventListener('click', () => {
            mobileNav.classList.remove('active');
            if (overlay) overlay.classList.remove('active');
        });
    }

    if (overlay) {
        overlay.addEventListener('click', () => {
            closeCartDrawer();
            closeQuickView();
            closeAuthModal();
            const orderModal = document.getElementById('order-success-modal');
            if (orderModal) orderModal.classList.remove('active');
        });
    }

    // Modal Close Buttons
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            closeQuickView();
            closeAuthModal();
            const orderModal = document.getElementById('order-success-modal');
            if (orderModal) orderModal.classList.remove('active');
            if (overlay) overlay.classList.remove('active');
        });
    });
});
