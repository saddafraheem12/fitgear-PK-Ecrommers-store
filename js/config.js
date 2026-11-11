/**
 * FITGEAR PAKISTAN - FRONTEND CONFIGURATION
 * 
 * Configures the backend API endpoint dynamically for:
 * 1. Production on Netlify (connecting to Render backend)
 * 2. Local development on Node.js server (http://localhost:3000)
 * 3. Local frontend live server (e.g. VS Code Live Server on :5500)
 */

window.FITGEAR_CONFIG = {
    // Render Backend Production URL
    // Update this value once your Render Web Service is created (e.g. 'https://fitgear-backend.onrender.com')
    API_BASE_URL: 'https://fitgear-pk.onrender.com',

    /**
     * Resolves the API Base URL based on current runtime environment.
     * Prevents hardcoded localhost URLs in production while keeping local dev seamless.
     */
    getApiUrl: function() {
        if (typeof window === 'undefined') return '';

        // 1. Check for manual override in localStorage (useful for debugging)
        const debugOverride = localStorage.getItem('fitgear_api_base');
        if (debugOverride) {
            return debugOverride.replace(/\/+$/, '');
        }

        const hostname = window.location.hostname;
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

        // 2. Localhost Development
        if (isLocal) {
            // If served directly from Node.js server on port 3000, use relative paths
            if (window.location.port === '3000') {
                return '';
            }
            // If opened via Live Server (port 5500, etc.) or file://
            return 'http://localhost:3000';
        }

        // 3. Production Deployment (Netlify or custom domain)
        return (this.API_BASE_URL || '').replace(/\/+$/, '');
    }
};
