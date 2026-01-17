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

// Initialize popup
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
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SETTINGS_UPDATED',
          settings
        });
        showStatus('Settings applied', 'success');
      } catch (error) {
        // Content script might not be loaded yet
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

    if (!tabs[0].url.includes('youtube.com/watch')) {
      showStatus('Not a YouTube watch page', 'error');
      return;
    }

    await chrome.tabs.sendMessage(tabs[0].id, { type: 'RESCAN' });
    showStatus('Page rescanned', 'success');
  } catch (error) {
    console.error('Failed to rescan:', error);
    showStatus('Failed to rescan (try reloading page)', 'error');
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
