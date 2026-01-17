// Preset languages with ISO codes
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ko', name: 'Korean' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'it', name: 'Italian' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'tr', name: 'Turkish' }
];

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  allowedLangs: ['en'],
  mode: 'hide',
  hideUnknown: false
};

// DOM elements
let enableToggle;
let languageList;
let modeRadios;
let hideUnknownCheckbox;
let rescanBtn;
let statusEl;

// Current settings
let settings = { ...DEFAULT_SETTINGS };

// ===========================================
// CONTENT SCRIPT COMMUNICATION HELPERS
// ===========================================

/**
 * Sends a PING to the content script to check if it's alive.
 * "Receiving end does not exist" error happens when:
 * - Content script hasn't loaded yet
 * - Page was navigated (SPA) and old context was destroyed
 * - Extension was reloaded but page wasn't refreshed
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} true if content script responded
 */
async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return response && response.ok === true;
  } catch (error) {
    // "Receiving end does not exist" or similar
    return false;
  }
}

/**
 * Injects the content script into the tab.
 * Used when PING fails, meaning content script isn't present.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} true if injection succeeded
 */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
    // Small delay to let the script initialize
    await new Promise(resolve => setTimeout(resolve, 200));
    return true;
  } catch (error) {
    console.error('[YLF Popup] Failed to inject content script:', error);
    return false;
  }
}

/**
 * Ensures content script is present and responsive.
 * Implements PING → inject → retry PING pattern.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} true if content script is ready
 */
async function ensureContentScript(tabId) {
  // First attempt: PING
  if (await pingContentScript(tabId)) {
    return true;
  }

  // Content script not responding, try to inject it
  const injected = await injectContentScript(tabId);
  if (!injected) {
    return false;
  }

  // Retry PING after injection
  return await pingContentScript(tabId);
}

/**
 * Sends a command to the content script with automatic injection if needed.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<{success: boolean, response?: any, error?: string}>}
 */
async function sendCommand(tabId, message) {
  // Ensure content script is present
  const ready = await ensureContentScript(tabId);
  if (!ready) {
    return {
      success: false,
      error: 'Cannot connect to this page. Please refresh the tab.'
    };
  }

  // Send the actual command
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return { success: true, response };
  } catch (error) {
    console.error('[YLF Popup] Command failed:', error);
    return {
      success: false,
      error: 'Connection lost. Please refresh the tab.'
    };
  }
}

// ===========================================
// INITIALIZATION
// ===========================================

document.addEventListener('DOMContentLoaded', async () => {
  // Cache DOM elements
  enableToggle = document.getElementById('enableToggle');
  languageList = document.getElementById('languageList');
  hideUnknownCheckbox = document.getElementById('hideUnknown');
  rescanBtn = document.getElementById('rescanBtn');
  statusEl = document.getElementById('status');

  // Build language checkboxes
  buildLanguageList();

  // Load settings
  await loadSettings();

  // Apply settings to UI
  applySettingsToUI();

  // Set up event listeners
  setupEventListeners();
});

function buildLanguageList() {
  languageList.innerHTML = LANGUAGES.map(lang => `
    <label class="language-item">
      <input type="checkbox" value="${lang.code}" data-lang="${lang.code}">
      <span>${lang.name}</span>
    </label>
  `).join('');
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('settings');
    if (result.settings) {
      settings = { ...DEFAULT_SETTINGS, ...result.settings };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
    showStatus('Failed to load settings', 'error');
  }
}

function applySettingsToUI() {
  // Enable toggle
  enableToggle.checked = settings.enabled;

  // Language checkboxes
  const langCheckboxes = languageList.querySelectorAll('input[type="checkbox"]');
  langCheckboxes.forEach(checkbox => {
    checkbox.checked = settings.allowedLangs.includes(checkbox.value);
  });

  // Mode radios
  const modeRadio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (modeRadio) {
    modeRadio.checked = true;
  }

  // Hide unknown checkbox
  hideUnknownCheckbox.checked = settings.hideUnknown;
}

function setupEventListeners() {
  // Enable toggle
  enableToggle.addEventListener('change', () => {
    settings.enabled = enableToggle.checked;
    saveAndNotify();
  });

  // Language checkboxes
  languageList.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      const langCode = e.target.value;
      if (e.target.checked) {
        if (!settings.allowedLangs.includes(langCode)) {
          settings.allowedLangs.push(langCode);
        }
      } else {
        settings.allowedLangs = settings.allowedLangs.filter(l => l !== langCode);
      }
      saveAndNotify();
    }
  });

  // Mode radios
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      settings.mode = radio.value;
      saveAndNotify();
    });
  });

  // Hide unknown checkbox
  hideUnknownCheckbox.addEventListener('change', () => {
    settings.hideUnknown = hideUnknownCheckbox.checked;
    saveAndNotify();
  });

  // Rescan button
  rescanBtn.addEventListener('click', rescanCurrentPage);
}

async function saveAndNotify() {
  try {
    // Save to storage
    await chrome.storage.local.set({ settings });

    // Notify content script
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url && tabs[0].url.includes('youtube.com')) {
      const result = await sendCommand(tabs[0].id, {
        type: 'SETTINGS_UPDATED',
        settings
      });

      if (result.success) {
        showStatus('Settings applied', 'success');
      } else {
        // Settings saved but couldn't notify - that's OK
        showStatus('Settings saved (reload page to apply)', 'success');
      }
    } else {
      showStatus('Settings saved', 'success');
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus('Failed to save settings', 'error');
  }
}

async function rescanCurrentPage() {
  rescanBtn.disabled = true;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tabs[0] || !tabs[0].url) {
      showStatus('Cannot access current tab', 'error');
      return;
    }

    // Check if it's a YouTube page (watch or shorts)
    const url = tabs[0].url;
    if (!url.includes('youtube.com/watch') && !url.includes('youtube.com/shorts')) {
      showStatus('Not a YouTube video page', 'error');
      return;
    }

    const result = await sendCommand(tabs[0].id, { type: 'RESCAN' });

    if (result.success) {
      showStatus('Page rescanned', 'success');
    } else {
      showStatus(result.error || 'Failed to rescan', 'error');
    }
  } catch (error) {
    console.error('Failed to rescan:', error);
    showStatus('Failed to rescan. Please refresh the page.', 'error');
  } finally {
    rescanBtn.disabled = false;
  }
}

function showStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = 'status ' + type;

  // Clear after 3 seconds
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = 'status';
  }, 3000);
}
