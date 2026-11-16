/**
 * FITGEAR PAKISTAN - FRONTEND CONFIGURATION
 * 
 * Configures the backend API endpoint dynamically for:
 * 1. Production on Netlify (Unified Netlify Functions - same origin relative requests)
 * 2. Local development on Netlify Dev (http://localhost:8888)
 * 3. Local development on Node.js server (http://localhost:3000)
 * 4. Local frontend live server (e.g. VS Code Live Server on :5500)
 */

window.FITGEAR_CONFIG = {
    // Netlify Functions Production API Base URL (empty string for same-origin relative requests)
    API_BASE_URL: '',

    /**
     * Resolves the API Base URL based on current runtime environment.
     * Prevents hardcoded localhost URLs in production while keeping local dev seamless.
     */
    getApiUrl: function() {
        if (typeof window === 'undefined') return '';

        // 1. Check for manual override in localStorage (useful for debugging/testing)
        const debugOverride = localStorage.getItem('fitgear_api_base');
        if (debugOverride) {
            return debugOverride.replace(/\/+$/, '');
        }

        const hostname = window.location.hostname;
        const port = window.location.port;
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

        // 2. Localhost Development
        if (isLocal) {
            // Served directly from Netlify Dev CLI (:8888) or Node.js server (:3000) -> use same-origin relative paths
            if (port === '8888' || port === '3000') {
                return '';
            }
            // Opened via Live Server (port 5500, 5173, etc.) or file:// -> route to local server.js
            return 'http://localhost:3000';
        }

        // 3. Production Deployment on Netlify (same origin)
        return (this.API_BASE_URL || '').replace(/\/+$/, '');
    }
};
