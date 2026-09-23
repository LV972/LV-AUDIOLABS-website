/**
 * LV AUDIO LABS - Cookie Consent System
 * Compliant with RGPD / ePrivacy
 */

(function() {
    const CONSENT_KEY = 'lvalabs-cookie-consent';
    const CONSENT_DURATION = 12 * 30 * 24 * 60 * 60 * 1000; // 12 months

    const defaults = {
        necessary: true,
        functional: false,
        timestamp: Date.now()
    };

    function getConsent() {
        const stored = localStorage.getItem(CONSENT_KEY);
        if (!stored) return null;
        
        const parsed = JSON.parse(stored);
        if (Date.now() - parsed.timestamp > CONSENT_DURATION) {
            localStorage.removeItem(CONSENT_KEY);
            return null;
        }
        return parsed;
    }

    function setConsent(consent) {
        localStorage.setItem(CONSENT_KEY, JSON.stringify({
            ...defaults,
            ...consent,
            timestamp: Date.now()
        }));
        
        // Dispatch event for other scripts to react (like Google Fonts loader)
        window.dispatchEvent(new CustomEvent('cookieConsentUpdated', { detail: consent }));
        
        // Hide banner
        document.getElementById('cookie-banner')?.remove();
    }

    function createBanner() {
        const banner = document.createElement('div');
        banner.id = 'cookie-banner';
        banner.setAttribute('role', 'dialog');
        banner.setAttribute('aria-label', 'Consentement aux cookies');
        banner.style.cssText = `
            position: fixed; bottom: 20px; left: 20px; right: 20px; 
            background: #151313; color: #f2ede7; padding: 24px; 
            border: 1px solid #2a2626; border-radius: 8px; z-index: 9999;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            max-width: 500px; margin: 0 auto; font-family: 'Work Sans', sans-serif;
        `;
        
        banner.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <div style="font-size: 0.95rem; line-height: 1.5;">
                    <strong>Cookies et confidentialité</strong><br>
                    Nous utilisons des cookies strictement nécessaires au fonctionnement du site et, avec votre accord, des services tiers comme Google Fonts. 
                    <a href="politique-cookies.html" style="color: #d61f3c; text-decoration: underline;">En savoir plus</a>.
                </div>
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button id="cookie-accept-all" style="background: #d61f3c; color: white; border: none; padding: 10px 18px; border-radius: 3px; cursor: pointer; font-weight: 600; flex: 1;">Tout accepter</button>
                    <button id="cookie-reject-all" style="background: transparent; color: #f2ede7; border: 1px solid #2a2626; padding: 10px 18px; border-radius: 3px; cursor: pointer; flex: 1;">Tout refuser</button>
                </div>
            </div>
        `;

        document.body.appendChild(banner);

        document.getElementById('cookie-accept-all').onclick = () => setConsent({ functional: true });
        document.getElementById('cookie-reject-all').onclick = () => setConsent({ functional: false });
    }

    // Initialize
    const currentConsent = getConsent();
    if (!currentConsent) {
        createBanner();
    } else {
        window.dispatchEvent(new CustomEvent('cookieConsentUpdated', { detail: currentConsent }));
    }
})();
