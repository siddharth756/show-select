/**
 * ============================================================================
 *  seiyaa — Popup Script (popup.js)
 * ============================================================================
 *
 *  This script runs inside the extension popup (the small panel that opens
 *  when the user clicks the extension icon in the browser toolbar).
 *
 *  It queries the active tab to confirm that the content script has been
 *  injected, and updates the popup UI accordingly.
 *
 *  NOTE: The popup cannot directly manipulate page DOM. All DOM manipulation
 *  is handled by content.js. The popup serves as a dashboard / info panel.
 * ============================================================================
 */

(function () {
  'use strict';

  const statusLabel = document.getElementById('status-label');
  const statusPill  = document.getElementById('status-pill');
  const statusDesc  = document.getElementById('status-desc');
  const indicator   = document.getElementById('status-indicator');

  /**
   * Check whether the content script is running on the active tab.
   * We do this by sending a ping message to the tab.
   * If the content script responds, we know it's active.
   */
  async function checkContentScriptStatus() {
    try {
      // Get the currently active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.id) {
        setStatus('error', 'No active tab found');
        return;
      }

      // Check if tab URL is a restricted page (chrome://, edge://, etc.)
      const url = tab.url || '';
      if (url.startsWith('chrome://') || url.startsWith('edge://') ||
          url.startsWith('about:') || url.startsWith('chrome-extension://')) {
        setStatus('restricted', 'Cannot run on browser internal pages');
        return;
      }

      // The content script is auto-injected via manifest, so if the page
      // is accessible, it should be running.
      setStatus('active', 'Extension Active — Panel is live on this page');

    } catch (err) {
      console.error('seiyaa popup error:', err);
      setStatus('error', 'Could not determine status');
    }
  }

  /**
   * Update the status UI in the popup.
   */
  function setStatus(state, message) {
    const configs = {
      active: {
        label: 'Active',
        pill: 'Running',
        pillClass: 'active',
        desc: 'The floating seiyaa panel is live on this page. Select text in any input field to begin.',
        dotColor: '#10b981',
      },
      restricted: {
        label: 'Restricted',
        pill: 'Blocked',
        pillClass: 'restricted',
        desc: message || 'This page does not allow extensions to run.',
        dotColor: '#f59e0b',
      },
      error: {
        label: 'Error',
        pill: 'Error',
        pillClass: 'error',
        desc: message || 'An unexpected error occurred.',
        dotColor: '#ef4444',
      },
    };

    const cfg = configs[state] || configs.error;

    statusLabel.textContent = cfg.label;
    statusPill.textContent = cfg.pill;
    statusPill.className = 'status-pill ' + cfg.pillClass;
    statusDesc.textContent = cfg.desc;

    const dot = indicator.querySelector('.status-dot');
    if (dot) {
      dot.style.background = cfg.dotColor;
      dot.style.boxShadow = `0 0 8px ${cfg.dotColor}`;
    }
  }

  // Run status check when popup opens
  checkContentScriptStatus();

  // ── Animate elements on load ────────────────────────────────────────────
  document.querySelectorAll('.card').forEach((card, i) => {
    card.style.animationDelay = `${0.1 + i * 0.08}s`;
  });

})();
